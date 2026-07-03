//! Native PSD template inspection: a minimal, read-only PSD/PSB parser that
//! extracts the canvas size and the flattened layer list (name + kind) the
//! `inspect_psd` command reports — the first PSD capability moved off the
//! Python bridge (see PYTHON_TO_RUST_MIGRATION_PLAN.md, "Phase 5").
//!
//! Scope is deliberately small: it reads the file header and the layer records
//! (names, group dividers, smart-object markers) and never decodes pixel data,
//! so it is fast and safe on multi-hundred-MB templates. Semantics mirror the
//! legacy `inspect_psd_cli.py` exactly: layers are listed in file order
//! (bottom-to-top), each group is followed by its children, names prefer the
//! Unicode (`luni`) block over the Pascal name, and the kind is one of
//! `"group"` / `"smartobject"` / `"pixel"`.

use std::fs;
use std::path::Path;

/// A parsed layer row: `name` + `kind` (`"group"` / `"smartobject"` /
/// `"pixel"`), matching the rows `inspect_psd_cli.py` prints.
pub(crate) struct NativeLayer {
    pub(crate) name: String,
    pub(crate) kind: &'static str,
}

/// Canvas size + flattened layer rows of a PSD/PSB template.
pub(crate) struct NativeInspect {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) layers: Vec<NativeLayer>,
}

/// Refuse to inspect a PSD whose declared canvas exceeds this many pixels
/// (decompression-bomb guard, aligned with the Python bridge CLIs).
pub(crate) const MAX_DECODE_PIXELS: u64 = 96_000_000;

/// Big-endian cursor over the raw PSD bytes with bounds-checked reads.
struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|&end| end <= self.data.len())
            .ok_or_else(|| format!("PSD truncated at byte {}", self.pos))?;
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn skip(&mut self, n: u64) -> Result<(), String> {
        let n = usize::try_from(n).map_err(|_| "PSD section length overflow".to_string())?;
        self.take(n).map(|_| ())
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn i16(&mut self) -> Result<i16, String> {
        Ok(i16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    /// A section length that is 4 bytes in PSD (version 1) and 8 in PSB.
    fn length(&mut self, psb: bool) -> Result<u64, String> {
        if psb {
            self.u64()
        } else {
            Ok(u64::from(self.u32()?))
        }
    }
}

/// Additional-info keys whose length field widens to 8 bytes in PSB files
/// (Adobe "Photoshop File Formats Specification", tagged blocks).
fn key_has_u64_length_in_psb(key: &[u8]) -> bool {
    matches!(
        key,
        b"LMsk"
            | b"Lr16"
            | b"Lr32"
            | b"Layr"
            | b"Mt16"
            | b"Mt32"
            | b"Mtrn"
            | b"Alph"
            | b"FMsk"
            | b"lnk2"
            | b"FEid"
            | b"FXid"
            | b"PxSD"
    )
}

/// One raw layer record, before the group tree is rebuilt.
struct RawLayer {
    name: String,
    /// `lsct`/`lsdk` section divider type: 1/2 = group start (the record is the
    /// group itself), 3 = group end marker. 0 = a normal layer.
    divider: u8,
    smart_object: bool,
}

/// Parse a single layer record (bounds, channels, blend data, extra data with
/// the Pascal name and tagged blocks) and distil it into a [`RawLayer`].
fn parse_layer_record(cur: &mut Cursor<'_>, psb: bool) -> Result<RawLayer, String> {
    // Bounds (top, left, bottom, right) — unused by inspect, but validated.
    for _ in 0..4 {
        cur.i32()?;
    }
    let channels = cur.u16()?;
    for _ in 0..channels {
        cur.i16()?; // channel id
        cur.length(psb)?; // channel data length
    }
    let sig = cur.take(4)?;
    if sig != b"8BIM" {
        return Err("invalid blend-mode signature in layer record".to_string());
    }
    cur.take(4)?; // blend mode key
    cur.u8()?; // opacity
    cur.u8()?; // clipping
    cur.u8()?; // flags
    cur.u8()?; // filler

    let extra_len = u64::from(cur.u32()?);
    let extra_end = cur.pos + usize::try_from(extra_len).map_err(|_| "extra data overflow")?;
    if extra_end > cur.data.len() {
        return Err("PSD layer extra data truncated".to_string());
    }

    // Layer mask data + blending ranges: length-prefixed, skipped.
    let mask_len = cur.u32()?;
    cur.skip(u64::from(mask_len))?;
    let ranges_len = cur.u32()?;
    cur.skip(u64::from(ranges_len))?;

    // Pascal name, padded to a multiple of 4 (including the length byte).
    let name_len = cur.u8()? as usize;
    let pascal = cur.take(name_len)?;
    let padded = (name_len + 1).div_ceil(4) * 4;
    cur.skip((padded - name_len - 1) as u64)?;
    let mut name = String::from_utf8_lossy(pascal).into_owned();

    let mut divider = 0u8;
    let mut smart_object = false;

    // Tagged blocks until the extra section ends.
    while cur.pos + 12 <= extra_end {
        let sig = cur.take(4)?;
        if sig != b"8BIM" && sig != b"8B64" {
            return Err("invalid tagged-block signature in layer record".to_string());
        }
        let key: [u8; 4] = cur.take(4)?.try_into().unwrap();
        let len = if psb && key_has_u64_length_in_psb(&key) {
            cur.u64()?
        } else {
            u64::from(cur.u32()?)
        };
        // Tagged-block payloads are padded to 2 bytes.
        let padded_len = len + (len & 1);
        let block_end = cur.pos + usize::try_from(padded_len).map_err(|_| "block overflow")?;
        if block_end > extra_end {
            return Err("PSD tagged block truncated".to_string());
        }
        match &key {
            b"lsct" | b"lsdk" => {
                let kind = cur.u32()?;
                divider = match kind {
                    1 | 2 => 1, // open/closed folder: this record is the group
                    3 => 3,     // bounding divider: end-of-group marker
                    _ => 0,
                };
            }
            b"luni" => {
                let count = cur.u32()? as usize;
                let mut units = Vec::with_capacity(count);
                for _ in 0..count {
                    units.push(cur.u16()?);
                }
                name = String::from_utf16_lossy(&units);
            }
            b"SoLd" | b"SoLE" => smart_object = true,
            _ => {}
        }
        cur.pos = block_end;
    }
    cur.pos = extra_end;

    Ok(RawLayer {
        name,
        divider,
        smart_object,
    })
}

/// Rebuild the group tree from the flat record list and emit the flattened
/// `name`/`kind` rows in the same order the Python CLI prints: file order
/// (bottom-to-top), each group immediately followed by its children.
fn flatten(records: Vec<RawLayer>) -> Vec<NativeLayer> {
    // Records run bottom-to-top: a group's end marker (divider 3) comes first,
    // then its children, then the group record itself (divider 1/2).
    let mut stack: Vec<Vec<NativeLayer>> = vec![Vec::new()];
    for record in records {
        match record.divider {
            3 => stack.push(Vec::new()),
            1 => {
                let children = stack.pop().unwrap_or_default();
                let level = stack.last_mut().expect("group stack underflow");
                level.push(NativeLayer {
                    name: record.name,
                    kind: "group",
                });
                level.extend(children);
            }
            _ => {
                let kind = if record.smart_object {
                    "smartobject"
                } else {
                    "pixel"
                };
                stack
                    .last_mut()
                    .expect("layer stack underflow")
                    .push(NativeLayer {
                        name: record.name,
                        kind,
                    });
            }
        }
    }
    // A malformed file may leave unclosed groups; flush them in order.
    let mut rows = Vec::new();
    for level in stack {
        rows.extend(level);
    }
    rows
}

/// Parse a PSD/PSB template from raw bytes: header (canvas size, guarded by
/// [`MAX_DECODE_PIXELS`]) plus the layer records.
pub(crate) fn parse_psd(data: &[u8]) -> Result<NativeInspect, String> {
    let mut cur = Cursor::new(data);
    if cur.take(4)? != b"8BPS" {
        return Err("not a PSD file (bad 8BPS signature)".to_string());
    }
    let version = cur.u16()?;
    let psb = match version {
        1 => false,
        2 => true,
        other => return Err(format!("unsupported PSD version {other}")),
    };
    cur.skip(6)?; // reserved
    cur.u16()?; // channels
    let height = cur.u32()?;
    let width = cur.u32()?;
    cur.u16()?; // depth
    cur.u16()?; // color mode

    if u64::from(width) * u64::from(height) > MAX_DECODE_PIXELS {
        return Err(format!(
            "PSD canvas too large to inspect safely: {width}x{height} \
             ({} px > max {MAX_DECODE_PIXELS})",
            u64::from(width) * u64::from(height)
        ));
    }

    let color_mode_len = cur.u32()?;
    cur.skip(u64::from(color_mode_len))?;
    let resources_len = cur.u32()?;
    cur.skip(u64::from(resources_len))?;

    // Layer & mask info section, containing the layer info sub-section.
    let layer_mask_len = cur.length(psb)?;
    let mut layers = Vec::new();
    if layer_mask_len > 0 {
        let layer_info_len = cur.length(psb)?;
        if layer_info_len > 0 {
            // Negative count: first alpha channel holds the merged transparency.
            let count = cur.i16()?.unsigned_abs();
            let mut records = Vec::with_capacity(usize::from(count));
            for _ in 0..count {
                records.push(parse_layer_record(&mut cur, psb)?);
            }
            layers = flatten(records);
        }
    }

    Ok(NativeInspect {
        width,
        height,
        layers,
    })
}

/// Read and parse a PSD template from disk.
pub(crate) fn inspect_psd_file(path: &Path) -> Result<NativeInspect, String> {
    let data = fs::read(path).map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    parse_psd(&data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture written by the vendored `psd_tools` (see the PR that introduced
    /// it): 64x48 canvas with `Red`, `MyGroup` (open) containing `Green` and a
    /// closed `SubGroup` holding a hidden `Blue`, plus a Unicode-named
    /// top-level layer. The expected rows are the golden output of
    /// `python/bridge/inspect_psd_cli.py` on the same file.
    const FIXTURE: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/inspect_template.psd"
    ));

    #[test]
    fn matches_python_cli_golden_output() {
        let parsed = parse_psd(FIXTURE).expect("fixture must parse");
        assert_eq!((parsed.width, parsed.height), (64, 48));
        let rows: Vec<(&str, &str)> = parsed
            .layers
            .iter()
            .map(|layer| (layer.name.as_str(), layer.kind))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("Red", "pixel"),
                ("MyGroup", "group"),
                ("Green", "pixel"),
                ("SubGroup", "group"),
                ("Blue", "pixel"),
                ("产品图", "pixel"),
            ]
        );
    }

    #[test]
    fn rejects_non_psd_bytes() {
        assert!(parse_psd(b"not a psd").is_err());
        assert!(parse_psd(b"").is_err());
    }

    #[test]
    fn rejects_oversized_canvas() {
        // Minimal header claiming a 100k x 100k canvas (10 gigapixels).
        let mut data = Vec::new();
        data.extend_from_slice(b"8BPS");
        data.extend_from_slice(&1u16.to_be_bytes());
        data.extend_from_slice(&[0u8; 6]);
        data.extend_from_slice(&4u16.to_be_bytes());
        data.extend_from_slice(&100_000u32.to_be_bytes()); // height
        data.extend_from_slice(&100_000u32.to_be_bytes()); // width
        data.extend_from_slice(&8u16.to_be_bytes());
        data.extend_from_slice(&3u16.to_be_bytes());
        let err = parse_psd(&data).map(|_| ()).unwrap_err();
        assert!(err.contains("too large to inspect"), "{err}");
    }

    #[test]
    fn truncated_file_is_an_error_not_a_panic() {
        // The parser never reads past the layer records, so only cuts inside
        // the header/layer sections must fail; all must return Err, not panic.
        for cut in 0..200usize.min(FIXTURE.len()) {
            assert!(parse_psd(&FIXTURE[..cut]).map(|_| ()).is_err(), "cut={cut}");
        }
    }
}
