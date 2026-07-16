//! Native PSD template reading: a minimal, read-only PSD/PSB parser behind the
//! `inspect_psd` and `analyze_psd_context` commands.
//!
//! The parser reads the file header and the layer records (names, bounds,
//! group dividers, smart-object markers, channel data locations) without
//! decoding any pixels, so inspection is fast and safe on multi-hundred-MB
//! templates; `super::analyze` decodes channels on demand. Layers are listed in file order
//! (bottom-to-top), each group is followed by its children, names prefer the
//! Unicode (`luni`) block over the Pascal name, and the kind is one of
//! `"group"` / `"smartobject"` / `"pixel"`.

use std::fs;
use std::path::Path;

/// A parsed layer row: `name` + `kind` (`"group"` / `"smartobject"` /
/// `"pixel"`), matching the public inspection contract.
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

/// Refuse to inspect a PSD whose declared canvas exceeds this many pixels.
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

/// Where one channel's compressed data lives in the file.
#[derive(Clone)]
pub(crate) struct ChannelRef {
    /// Channel id: 0/1/2 = R/G/B, -1 = transparency alpha, -2 = layer mask.
    pub(crate) id: i16,
    /// Byte offset of the channel data block (starts with a compression u16).
    pub(crate) offset: usize,
    pub(crate) len: usize,
}

/// A parsed layer in the rebuilt group tree.
pub(crate) struct LayerNode {
    pub(crate) name: String,
    pub(crate) kind: &'static str,
    /// Record rectangle as (top, left, bottom, right) in canvas pixels.
    pub(crate) rect: [i32; 4],
    pub(crate) channels: Vec<ChannelRef>,
    /// Blend mode key, e.g. `norm`.
    pub(crate) blend: [u8; 4],
    pub(crate) opacity: u8,
    /// Non-zero: this layer clips onto the layer below.
    pub(crate) clipping: u8,
    /// Visibility from the record flags (bit 1 = hidden).
    pub(crate) visible: bool,
    pub(crate) children: Vec<LayerNode>,
}

impl LayerNode {
    /// `(left, top, right, bottom)` like psd_tools `layer.bbox`: the record
    /// rect for a normal layer, the union of child bboxes for a group.
    pub(crate) fn bbox(&self) -> (i32, i32, i32, i32) {
        if self.kind != "group" {
            let [top, left, bottom, right] = self.rect;
            return (left, top, right, bottom);
        }
        let mut acc: Option<(i32, i32, i32, i32)> = None;
        for child in &self.children {
            let (l, t, r, b) = child.bbox();
            if r <= l || b <= t {
                continue;
            }
            acc = Some(match acc {
                None => (l, t, r, b),
                Some((al, at, ar, ab)) => (al.min(l), at.min(t), ar.max(r), ab.max(b)),
            });
        }
        acc.unwrap_or((0, 0, 0, 0))
    }
}

/// The full parse result: header facts plus the layer tree.
pub(crate) struct ParsedPsd {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) depth: u16,
    /// PSD color mode (3 = RGB — the only mode the native path decodes).
    pub(crate) color_mode: u16,
    pub(crate) psb: bool,
    pub(crate) tree: Vec<LayerNode>,
}

/// One raw layer record, before the group tree is rebuilt.
struct RawLayer {
    name: String,
    /// `lsct`/`lsdk` section divider type: 1/2 = group start (the record is the
    /// group itself), 3 = group end marker. 0 = a normal layer.
    divider: u8,
    smart_object: bool,
    rect: [i32; 4],
    /// (id, data length) per channel, in record order.
    channel_lens: Vec<(i16, u64)>,
    blend: [u8; 4],
    opacity: u8,
    clipping: u8,
    visible: bool,
    /// Absolute offset of the flags byte inside the record.
    flags_offset: usize,
}

/// Parse a single layer record (bounds, channels, blend data, extra data with
/// the Pascal name and tagged blocks) and distil it into a [`RawLayer`].
fn parse_layer_record(cur: &mut Cursor<'_>, psb: bool) -> Result<RawLayer, String> {
    // Bounds: top, left, bottom, right.
    let mut rect = [0i32; 4];
    for slot in &mut rect {
        *slot = cur.i32()?;
    }
    let channels = cur.u16()?;
    let mut channel_lens = Vec::with_capacity(usize::from(channels));
    for _ in 0..channels {
        let id = cur.i16()?;
        let len = cur.length(psb)?;
        channel_lens.push((id, len));
    }
    let sig = cur.take(4)?;
    if sig != b"8BIM" {
        return Err("invalid blend-mode signature in layer record".to_string());
    }
    let blend: [u8; 4] = cur.take(4)?.try_into().unwrap();
    let opacity = cur.u8()?;
    let clipping = cur.u8()?;
    let flags_offset = cur.pos;
    let flags = cur.u8()?;
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
        rect,
        channel_lens,
        blend,
        opacity,
        clipping,
        visible: flags & 0x02 == 0,
        flags_offset,
    })
}

/// Rebuild the group tree from the flat record list. Records run
/// bottom-to-top: a group's end marker (divider 3) comes first, then its
/// children, then the group record itself (divider 1/2).
fn build_tree(records: Vec<(RawLayer, Vec<ChannelRef>)>) -> Vec<LayerNode> {
    let mut stack: Vec<Vec<LayerNode>> = vec![Vec::new()];
    for (record, channels) in records {
        match record.divider {
            3 => stack.push(Vec::new()),
            1 => {
                let children = stack.pop().unwrap_or_default();
                let level = stack.last_mut().expect("group stack underflow");
                level.push(LayerNode {
                    name: record.name,
                    kind: "group",
                    rect: record.rect,
                    channels,
                    blend: record.blend,
                    opacity: record.opacity,
                    clipping: record.clipping,
                    visible: record.visible,
                    children,
                });
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
                    .push(LayerNode {
                        name: record.name,
                        kind,
                        rect: record.rect,
                        channels,
                        blend: record.blend,
                        opacity: record.opacity,
                        clipping: record.clipping,
                        visible: record.visible,
                        children: Vec::new(),
                    });
            }
        }
    }
    // A malformed file may leave unclosed groups; flush them in order.
    let mut tree = Vec::new();
    for level in stack {
        tree.extend(level);
    }
    tree
}

/// Flatten the tree into the `name`/`kind` contract rows: file
/// order (bottom-to-top), each group immediately followed by its children.
fn flatten(tree: &[LayerNode], rows: &mut Vec<NativeLayer>) {
    for node in tree {
        rows.push(NativeLayer {
            name: node.name.clone(),
            kind: node.kind,
        });
        flatten(&node.children, rows);
    }
}

/// One raw record plus where its bytes (and its channel data bytes) live in
/// the file — what the native compose writer needs to reassemble the layer
/// info section around inserted records.
pub(crate) struct RecordSpan {
    /// 1 = the record is a group, 3 = end-of-group marker, 0 = normal layer.
    pub(crate) divider: u8,
    pub(crate) name: String,
    pub(crate) smart_object: bool,
    /// Record rectangle as (top, left, bottom, right) in canvas pixels.
    pub(crate) rect: [i32; 4],
    /// Byte range of the whole layer record.
    pub(crate) record_range: (usize, usize),
    /// Absolute offset of the record's flags byte (bit 1 = hidden).
    pub(crate) flags_offset: usize,
    /// Byte range of the record's channel data blocks.
    pub(crate) channel_range: (usize, usize),
    /// (id, data length) per channel, in record order.
    pub(crate) channel_lens: Vec<(i16, u64)>,
}

/// Header facts plus record/channel byte spans, for the compose writer.
pub(crate) struct PsdSpans {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) depth: u16,
    pub(crate) color_mode: u16,
    pub(crate) psb: bool,
    /// True when the layer count was negative (merged alpha present).
    pub(crate) count_negative: bool,
    /// Offset of the layer & mask info section's length field.
    pub(crate) layer_mask_len_offset: usize,
    /// First byte after the layer & mask info section.
    pub(crate) layer_mask_end: usize,
    /// First byte after the layer info sub-section (including its padding).
    pub(crate) layer_info_end: usize,
    pub(crate) records: Vec<RecordSpan>,
}

/// The shared single-pass parse behind [`parse_psd_full`] and
/// [`parse_psd_spans`].
struct ParsedRaw {
    width: u32,
    height: u32,
    depth: u16,
    color_mode: u16,
    psb: bool,
    count_negative: bool,
    layer_mask_len_offset: usize,
    layer_mask_end: usize,
    layer_info_end: usize,
    has_layer_info: bool,
    records: Vec<(RawLayer, Vec<ChannelRef>, (usize, usize), (usize, usize))>,
}

fn parse_psd_raw(data: &[u8]) -> Result<ParsedRaw, String> {
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
    cur.u16()?; // channel count
    let height = cur.u32()?;
    let width = cur.u32()?;
    let depth = cur.u16()?;
    let color_mode = cur.u16()?;

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
    let layer_mask_len_offset = cur.pos;
    let layer_mask_len = cur.length(psb)?;
    let layer_mask_end = cur
        .pos
        .checked_add(usize::try_from(layer_mask_len).map_err(|_| "section overflow")?)
        .filter(|&end| end <= data.len())
        .ok_or("PSD layer & mask info section truncated")?;
    let mut records = Vec::new();
    let mut layer_info_end = cur.pos;
    let mut count_negative = false;
    let mut has_layer_info = false;
    if layer_mask_len > 0 {
        let layer_info_len_offset = cur.pos;
        let layer_info_len = cur.length(psb)?;
        layer_info_end = layer_info_len_offset
            + if psb { 8 } else { 4 }
            + usize::try_from(layer_info_len).map_err(|_| "layer info overflow")?;
        if layer_info_end > layer_mask_end {
            return Err("PSD layer info section truncated".to_string());
        }
        if layer_info_len > 0 {
            has_layer_info = true;
            // Negative count: first alpha channel holds the merged transparency.
            let signed_count = cur.i16()?;
            count_negative = signed_count < 0;
            let count = signed_count.unsigned_abs();
            let mut raw_records = Vec::with_capacity(usize::from(count));
            for _ in 0..count {
                let start = cur.pos;
                let record = parse_layer_record(&mut cur, psb)?;
                raw_records.push((record, (start, cur.pos)));
            }
            // Channel data blocks follow all layer records, per layer in
            // record order; resolve each channel's byte range now.
            for (record, record_range) in raw_records {
                let channel_start = cur.pos;
                let mut channels = Vec::with_capacity(record.channel_lens.len());
                for &(id, len) in &record.channel_lens {
                    let len = usize::try_from(len).map_err(|_| "channel length overflow")?;
                    let offset = cur.pos;
                    cur.skip(len as u64)?;
                    channels.push(ChannelRef { id, offset, len });
                }
                records.push((record, channels, record_range, (channel_start, cur.pos)));
            }
        }
    }

    Ok(ParsedRaw {
        width,
        height,
        depth,
        color_mode,
        psb,
        count_negative,
        layer_mask_len_offset,
        layer_mask_end,
        layer_info_end,
        has_layer_info,
        records,
    })
}

/// Parse a PSD/PSB template from raw bytes: header (canvas size, guarded by
/// [`MAX_DECODE_PIXELS`]), layer records (with channel data locations), and
/// the offset of the merged image data section. No pixel data is decoded.
pub(crate) fn parse_psd_full(data: &[u8]) -> Result<ParsedPsd, String> {
    let raw = parse_psd_raw(data)?;
    let tree = build_tree(
        raw.records
            .into_iter()
            .map(|(record, channels, _, _)| (record, channels))
            .collect(),
    );
    Ok(ParsedPsd {
        width: raw.width,
        height: raw.height,
        depth: raw.depth,
        color_mode: raw.color_mode,
        psb: raw.psb,
        tree,
    })
}

/// Parse the byte spans the native compose writer needs. Errors when the file
/// has no layer info sub-section to splice into.
pub(crate) fn parse_psd_spans(data: &[u8]) -> Result<PsdSpans, String> {
    let raw = parse_psd_raw(data)?;
    if !raw.has_layer_info {
        return Err(
            "PSD has no layer info section; native PSD composition requires layer records"
                .to_string(),
        );
    }
    let records = raw
        .records
        .into_iter()
        .map(|(record, _, record_range, channel_range)| RecordSpan {
            divider: record.divider,
            name: record.name,
            smart_object: record.smart_object,
            rect: record.rect,
            record_range,
            flags_offset: record.flags_offset,
            channel_range,
            channel_lens: record.channel_lens,
        })
        .collect();
    Ok(PsdSpans {
        width: raw.width,
        height: raw.height,
        depth: raw.depth,
        color_mode: raw.color_mode,
        psb: raw.psb,
        count_negative: raw.count_negative,
        layer_mask_len_offset: raw.layer_mask_len_offset,
        layer_mask_end: raw.layer_mask_end,
        layer_info_end: raw.layer_info_end,
        records,
    })
}

/// Parse only what `inspect_psd` needs: canvas size + flattened layer rows.
pub(crate) fn parse_psd(data: &[u8]) -> Result<NativeInspect, String> {
    let parsed = parse_psd_full(data)?;
    let mut layers = Vec::new();
    flatten(&parsed.tree, &mut layers);
    Ok(NativeInspect {
        width: parsed.width,
        height: parsed.height,
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
    /// top-level layer. The expected rows are the checked-in golden contract.
    const FIXTURE: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/inspect_template.psd"
    ));

    #[test]
    fn matches_inspection_golden_output() {
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
