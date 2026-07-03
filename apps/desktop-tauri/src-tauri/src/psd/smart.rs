//! Native smart-object content replacement: swap the embedded source file of
//! an embedded (`kind = data`) smart object and refresh the layer's cached
//! raster, mirroring the local psd_tools extension
//! `SmartObjectLayer.replace_with_image` (the last compose capability moved
//! off the Python bridge — PYTHON_TO_RUST_MIGRATION_PLAN.md, "Phase 5").
//!
//! Like the pixel-layer writer, this splices the template bytes instead of
//! re-serialising the document. Exactly three spots change:
//!
//! 1. the placeholder's layer record — new bounds and raw channel info; the
//!    blend data and the whole extra-data block (layer mask, name, `SoLd` /
//!    `luni` tagged blocks) are copied verbatim so the layer stays a smart
//!    object with its UUID, transform and warp intact,
//! 2. its channel data — raw RGBA planes of the new content, so
//!    `composite()`-style previews show the new pixels,
//! 3. the document-level linked-layer block (`lnkD`/`lnk2`/`lnk3`), where the
//!    item whose UUID matches the layer's `SoLd` descriptor gets its embedded
//!    bytes, size and file type replaced (Photoshop re-renders from this
//!    source and keeps the object editable).
//!
//! External or aliased links and open-file descriptors return an error so the
//! command can fall back to the legacy bridge.

use image::RgbaImage;

use super::inspect::{PsdSpans, RecordSpan};

fn pad4(len: usize) -> usize {
    len.div_ceil(4) * 4
}

fn read_u32(data: &[u8], pos: usize) -> Result<u32, String> {
    data.get(pos..pos + 4)
        .map(|b| u32::from_be_bytes(b.try_into().unwrap()))
        .ok_or_else(|| format!("PSD truncated at byte {pos}"))
}

fn read_u64(data: &[u8], pos: usize) -> Result<u64, String> {
    data.get(pos..pos + 8)
        .map(|b| u64::from_be_bytes(b.try_into().unwrap()))
        .ok_or_else(|| format!("PSD truncated at byte {pos}"))
}

/// Keys whose tagged-block length field widens to 8 bytes in PSB files
/// (psd_tools `TaggedBlock._BIG_KEYS`).
fn global_key_has_u64_length_in_psb(key: &[u8]) -> bool {
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
            | b"lnk3"
            | b"lnkE"
            | b"FXid"
            | b"FEid"
            | b"PxSD"
            | b"pths"
            | b"extd"
            | b"extn"
            | b"cinf"
            | b"artd"
    )
}

/// Extract the smart object's UUID from the record's `SoLd`/`SoLE` descriptor
/// by locating the `Idnt` key (a `TEXT` unicode string). The scan is confined
/// to the record's own bytes, so multiple smart objects cannot collide.
pub(super) fn smart_object_uuid(data: &[u8], record: &RecordSpan) -> Result<String, String> {
    let bytes = &data[record.record_range.0..record.record_range.1];
    let marker = b"IdntTEXT";
    let pos = bytes
        .windows(marker.len())
        .position(|window| window == marker)
        .ok_or("smart object has no Idnt descriptor key; legacy bridge required")?;
    let value_at = record.record_range.0 + pos + marker.len();
    let count = read_u32(data, value_at)? as usize;
    let mut units = Vec::with_capacity(count);
    for index in 0..count {
        let unit_at = value_at + 4 + index * 2;
        let unit = data
            .get(unit_at..unit_at + 2)
            .map(|b| u16::from_be_bytes(b.try_into().unwrap()))
            .ok_or("PSD smart object descriptor truncated")?;
        units.push(unit);
    }
    Ok(String::from_utf16_lossy(&units)
        .trim_end_matches('\0')
        .to_string())
}

/// Skip a unicode string (u32 UTF-16 unit count + units), returning the
/// offset just past it.
fn skip_unicode(data: &[u8], pos: usize) -> Result<usize, String> {
    let count = read_u32(data, pos)? as usize;
    Ok(pos + 4 + count * 2)
}

/// Skip a descriptor key / class ID (u32 length, 0 meaning 4 bytes).
fn skip_key(data: &[u8], pos: usize) -> Result<usize, String> {
    let len = read_u32(data, pos)? as usize;
    Ok(pos + 4 + if len == 0 { 4 } else { len })
}

/// Skip one OSType value inside a descriptor. Unsupported types (references,
/// object arrays) error so the caller can fall back to the legacy bridge.
fn skip_ostype(data: &[u8], pos: usize) -> Result<usize, String> {
    let key = data.get(pos..pos + 4).ok_or("PSD descriptor truncated")?;
    let pos = pos + 4;
    match key {
        b"Objc" | b"GlbO" => skip_descriptor(data, pos),
        b"VlLs" => {
            let count = read_u32(data, pos)?;
            let mut cursor = pos + 4;
            for _ in 0..count {
                cursor = skip_ostype(data, cursor)?;
            }
            Ok(cursor)
        }
        b"doub" | b"comp" => Ok(pos + 8),
        b"UntF" => Ok(pos + 12),
        b"TEXT" => skip_unicode(data, pos),
        b"enum" => skip_key(data, skip_key(data, pos)?),
        b"long" => Ok(pos + 4),
        b"bool" => Ok(pos + 1),
        b"type" | b"GlbC" => skip_key(data, skip_unicode(data, pos)?),
        b"alis" | b"tdta" => {
            let len = read_u32(data, pos)? as usize;
            Ok(pos + 4 + len)
        }
        b"UnFl" => {
            let count = read_u32(data, pos + 4)? as usize;
            Ok(pos + 8 + count * 8)
        }
        other => Err(format!(
            "unsupported descriptor value type {:?}; legacy bridge required",
            String::from_utf8_lossy(other)
        )),
    }
}

/// Skip a descriptor (name + class ID + keyed items).
fn skip_descriptor(data: &[u8], pos: usize) -> Result<usize, String> {
    let mut cursor = skip_key(data, skip_unicode(data, pos)?)?;
    let count = read_u32(data, cursor)?;
    cursor += 4;
    for _ in 0..count {
        cursor = skip_ostype(data, skip_key(data, cursor)?)?;
    }
    Ok(cursor)
}

/// Skip a `DescriptorBlock` (u32 version 16 + descriptor, unpadded).
fn skip_descriptor_block(data: &[u8], pos: usize) -> Result<usize, String> {
    let version = read_u32(data, pos)?;
    if version != 16 {
        return Err(format!("unsupported descriptor version {version}"));
    }
    skip_descriptor(data, pos + 4)
}

/// Where the matching linked-layer item and its container block live.
struct LinkedItemSpan {
    /// The enclosing global tagged block.
    block_len_offset: usize,
    block_len_is_u64: bool,
    block_data_range: (usize, usize),
    /// First byte after the block's 4-byte padding.
    block_padded_end: usize,
    /// Offset of the item's own u64 length field.
    item_len_offset: usize,
    /// The item bytes (after the length field, unpadded).
    item_range: (usize, usize),
    /// First byte after the item's 4-byte padding.
    item_padded_end: usize,
    filetype_offset: usize,
    datasize_offset: usize,
    data_range: (usize, usize),
}

/// Walk the document-level tagged blocks (after the layer info sub-section
/// and the global mask info) and find the embedded linked-layer item whose
/// UUID matches.
fn find_linked_item(data: &[u8], spans: &PsdSpans, uuid: &str) -> Result<LinkedItemSpan, String> {
    let mut pos = spans.layer_info_end;
    // Global layer mask info: a u32-length block.
    if pos + 4 <= spans.layer_mask_end {
        let len = read_u32(data, pos)? as usize;
        pos += 4 + len;
    }
    while pos + 12 <= spans.layer_mask_end {
        let sig = &data[pos..pos + 4];
        if sig != b"8BIM" && sig != b"8B64" {
            break;
        }
        let key = &data[pos + 4..pos + 8];
        let len_offset = pos + 8;
        let len_is_u64 = spans.psb && global_key_has_u64_length_in_psb(key);
        let (len, data_start) = if len_is_u64 {
            (read_u64(data, len_offset)? as usize, len_offset + 8)
        } else {
            (read_u32(data, len_offset)? as usize, len_offset + 4)
        };
        let data_end = data_start + len;
        let padded_end = data_start + pad4(len);
        if padded_end > spans.layer_mask_end {
            return Err("PSD global tagged block truncated".to_string());
        }
        if matches!(key, b"lnkD" | b"lnk2" | b"lnk3") {
            if let Some(item) = find_item_in_block(data, data_start, data_end, uuid)? {
                return Ok(LinkedItemSpan {
                    block_len_offset: len_offset,
                    block_len_is_u64: len_is_u64,
                    block_data_range: (data_start, data_end),
                    block_padded_end: padded_end,
                    ..item
                });
            }
        }
        pos = padded_end;
    }
    Err(format!(
        "embedded smart object data for UUID {uuid} was not found; legacy bridge required"
    ))
}

/// Scan one linked-layer block for the embedded (`liFD`) item with `uuid`.
/// Returns a span with the block fields left at placeholder values.
fn find_item_in_block(
    data: &[u8],
    start: usize,
    end: usize,
    uuid: &str,
) -> Result<Option<LinkedItemSpan>, String> {
    let mut pos = start;
    while pos + 8 <= end {
        let item_len = read_u64(data, pos)? as usize;
        let item_start = pos + 8;
        let item_end = item_start + item_len;
        if item_end > end {
            return Err("PSD linked-layer item truncated".to_string());
        }
        let item_padded_end = item_start + pad4(item_len);

        // kind (4) + version (4) + Pascal uuid (unpadded).
        let kind = &data[item_start..item_start + 4];
        let uuid_len = *data
            .get(item_start + 8)
            .ok_or("PSD linked-layer item truncated")? as usize;
        let uuid_bytes = data
            .get(item_start + 9..item_start + 9 + uuid_len)
            .ok_or("PSD linked-layer item truncated")?;
        let item_uuid = String::from_utf8_lossy(uuid_bytes);
        if item_uuid.trim_end_matches('\0') == uuid {
            if kind != b"liFD" {
                return Err(format!(
                    "smart object {uuid} is not embedded (kind {}); legacy bridge required",
                    String::from_utf8_lossy(kind)
                ));
            }
            // Unicode filename: u32 count + UTF-16 units.
            let name_at = item_start + 9 + uuid_len;
            let name_units = read_u32(data, name_at)? as usize;
            let filetype_offset = name_at + 4 + name_units * 2;
            let datasize_offset = filetype_offset + 8; // + creator
            let datasize = read_u64(data, datasize_offset)? as usize;
            let open_file_offset = datasize_offset + 8;
            let open_file = *data
                .get(open_file_offset)
                .ok_or("PSD linked-layer item truncated")?;
            let data_start = if open_file != 0 {
                skip_descriptor_block(data, open_file_offset + 1)?
            } else {
                open_file_offset + 1
            };
            let data_end = data_start + datasize;
            if data_end > item_end {
                return Err("PSD linked-layer item data truncated".to_string());
            }
            return Ok(Some(LinkedItemSpan {
                block_len_offset: 0,
                block_len_is_u64: false,
                block_data_range: (0, 0),
                block_padded_end: 0,
                item_len_offset: pos,
                item_range: (item_start, item_end),
                item_padded_end,
                filetype_offset,
                datasize_offset,
                data_range: (data_start, data_end),
            }));
        }
        pos = item_padded_end;
    }
    Ok(None)
}

/// Serialise the placeholder's record with new bounds and raw RGBA channel
/// info, keeping everything from the blend-mode signature on (including the
/// smart-object tagged blocks) byte-identical.
fn rebuild_record(
    data: &[u8],
    record: &RecordSpan,
    psb: bool,
    rect: [i32; 4],
    plane_len: u64,
) -> Vec<u8> {
    let field = if psb { 8 } else { 4 };
    let blend_offset = record.record_range.0 + 16 + 2 + record.channel_lens.len() * (2 + field);

    let mut out = Vec::new();
    for value in rect {
        out.extend_from_slice(&value.to_be_bytes());
    }
    out.extend_from_slice(&4u16.to_be_bytes());
    for id in [-1i16, 0, 1, 2] {
        out.extend_from_slice(&id.to_be_bytes());
        if psb {
            out.extend_from_slice(&plane_len.to_be_bytes());
        } else {
            out.extend_from_slice(&(plane_len as u32).to_be_bytes());
        }
    }
    out.extend_from_slice(&data[blend_offset..record.record_range.1]);
    out
}

/// Raw (uncompressed) channel data blocks for ids -1, 0, 1, 2.
fn encode_raw_channels(layer: &RgbaImage) -> Vec<u8> {
    let mut out = Vec::new();
    for id in [-1i16, 0, 1, 2] {
        let plane_index = match id {
            -1 => 3,
            other => other as usize,
        };
        out.extend_from_slice(&0u16.to_be_bytes()); // raw compression
        for pixel in layer.pixels() {
            out.push(pixel.0[plane_index]);
        }
    }
    out
}

/// Replace the embedded content of the smart object at `record_index`: new
/// record bounds/channels (`rect` must match `layer`'s size), raw raster from
/// `layer`, and `embedded` as the new linked-layer source bytes (declared as
/// a PNG). Every other byte of the template is preserved.
pub(super) fn replace_smart_object(
    data: &[u8],
    spans: &PsdSpans,
    record_index: usize,
    rect: [i32; 4],
    layer: &RgbaImage,
    embedded: &[u8],
) -> Result<Vec<u8>, String> {
    let record = &spans.records[record_index];
    let uuid = smart_object_uuid(data, record)?;
    let item = find_linked_item(data, spans, &uuid)?;

    let field = |psb: bool| if psb { 8usize } else { 4 };
    let lm_field = field(spans.psb);
    let li_len_offset = spans.layer_mask_len_offset + lm_field;
    let records_start = li_len_offset + lm_field + 2;
    let channel_start = spans
        .records
        .first()
        .map(|r| r.channel_range.0)
        .unwrap_or(records_start);
    let channel_end = spans
        .records
        .last()
        .map(|r| r.channel_range.1)
        .unwrap_or(channel_start);

    // Rebuilt layer info: count + records (placeholder record replaced) +
    // channel data (placeholder channels replaced).
    let plane_len = u64::from(layer.width()) * u64::from(layer.height()) + 2;
    let new_record = rebuild_record(data, record, spans.psb, rect, plane_len);
    let new_channels = encode_raw_channels(layer);

    let mut info = Vec::new();
    let signed = if spans.count_negative {
        -(spans.records.len() as i16)
    } else {
        spans.records.len() as i16
    };
    info.extend_from_slice(&signed.to_be_bytes());
    info.extend_from_slice(&data[records_start..record.record_range.0]);
    info.extend_from_slice(&new_record);
    info.extend_from_slice(&data[record.record_range.1..channel_start]);
    info.extend_from_slice(&data[channel_start..record.channel_range.0]);
    info.extend_from_slice(&new_channels);
    info.extend_from_slice(&data[record.channel_range.1..channel_end]);
    if info.len() % 2 != 0 {
        info.push(0);
    }

    // Rebuilt linked-layer item: head with patched filetype + datasize, the
    // new embedded bytes, then the original tail (child id, mod time, locks).
    let mut item_bytes = data[item.item_range.0..item.data_range.0].to_vec();
    let ft = item.filetype_offset - item.item_range.0;
    item_bytes[ft..ft + 4].copy_from_slice(b"png ");
    let ds = item.datasize_offset - item.item_range.0;
    item_bytes[ds..ds + 8].copy_from_slice(&(embedded.len() as u64).to_be_bytes());
    item_bytes.extend_from_slice(embedded);
    item_bytes.extend_from_slice(&data[item.data_range.1..item.item_range.1]);

    // Rebuilt global block around the new item.
    let mut block = data[item.block_data_range.0..item.item_len_offset].to_vec();
    block.extend_from_slice(&(item_bytes.len() as u64).to_be_bytes());
    let unpadded = block.len() + item_bytes.len();
    block.extend_from_slice(&item_bytes);
    block.extend(std::iter::repeat_n(0u8, pad4(unpadded) - unpadded));
    block.extend_from_slice(&data[item.item_padded_end..item.block_data_range.1]);

    // Tail of the layer & mask section with the block spliced in.
    let mut tail = data[spans.layer_info_end..item.block_len_offset].to_vec();
    if item.block_len_is_u64 {
        tail.extend_from_slice(&(block.len() as u64).to_be_bytes());
    } else {
        let len = u32::try_from(block.len())
            .map_err(|_| "linked-layer block exceeds the PSD 4 GB limit")?;
        tail.extend_from_slice(&len.to_be_bytes());
    }
    let block_len = block.len();
    tail.extend_from_slice(&block);
    tail.extend(std::iter::repeat_n(0u8, pad4(block_len) - block_len));
    tail.extend_from_slice(&data[item.block_padded_end..spans.layer_mask_end]);

    let mut out = Vec::with_capacity(data.len() + embedded.len() + new_channels.len());
    out.extend_from_slice(&data[..spans.layer_mask_len_offset]);
    let layer_mask_len = (lm_field + info.len() + tail.len()) as u64;
    let layer_info_len = info.len() as u64;
    if spans.psb {
        out.extend_from_slice(&layer_mask_len.to_be_bytes());
        out.extend_from_slice(&layer_info_len.to_be_bytes());
    } else {
        let as_u32 = |value: u64, what: &str| -> Result<u32, String> {
            u32::try_from(value).map_err(|_| format!("{what} exceeds the PSD 4 GB section limit"))
        };
        out.extend_from_slice(&as_u32(layer_mask_len, "layer & mask section")?.to_be_bytes());
        out.extend_from_slice(&as_u32(layer_info_len, "layer info section")?.to_be_bytes());
    }
    out.extend_from_slice(&info);
    out.extend_from_slice(&tail);
    out.extend_from_slice(&data[spans.layer_mask_end..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::super::inspect::{parse_psd_full, parse_psd_spans};
    use super::super::write::{compose_psd_native, ComposeArgs};
    use super::*;
    use std::fs;

    /// psd-tools' `placedLayer.psd` test file: a 256x256 RGB document with a
    /// pixel `Background`, two external smart objects and one embedded
    /// (`liFD`) PNG smart object named `embedded-png` at (96, 96)–(160, 160).
    const TEMPLATE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/smart_object_template.psd"
    );
    /// The 8x6 solid RGBA (10, 200, 30, 255) generated image.
    const GENERATED: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/compose_generated.png"
    );
    /// `final_preview.png` written by `compose_psd_cli.py` for the same job
    /// (replace_content into `embedded-png`, contain fit).
    const PYTHON_PREVIEW: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/smart_preview_python.png"
    ));

    fn out_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hgripe_smart_{tag}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run(tag: &str) -> (std::path::PathBuf, crate::psd::ComposePsdResult) {
        let dir = out_dir(tag);
        let result = compose_psd_native(&ComposeArgs {
            template: TEMPLATE,
            image: GENERATED,
            mask: "",
            output_dir: dir.to_str().unwrap(),
            filename: "final",
            placeholder: r#"{"name": "embedded-png"}"#,
            fit_mode: "contain",
            z_order: "above_background",
            smart_object_mode: "replace_content",
            hide_placeholder: true,
            metadata: r#"{"job": "x"}"#,
            save_preview: true,
        })
        .expect("native smart-object replace succeeds");
        (dir, result)
    }

    #[test]
    fn golden_smart_object_replace_matches_python_cli() {
        let (dir, result) = run("golden");
        assert_eq!(result.smart_object_mode, "replace_content");
        assert_eq!(result.placeholder_kind.as_deref(), Some("smartobject"));

        // The layer tree is unchanged: no 03_GENERATED group, the placeholder
        // is still a smart object with its original bounds and visibility.
        let written = fs::read(dir.join("final.psd")).unwrap();
        let parsed = parse_psd_full(&written).unwrap();
        let names: Vec<&str> = parsed.tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Background", "linked-png", "linked-psd", "embedded-png"]
        );
        let layer = &parsed.tree[3];
        assert_eq!(layer.kind, "smartobject");
        assert!(layer.visible);
        assert_eq!(layer.rect, [96, 96, 160, 160]);

        // The embedded source was swapped: the linked-layer item now holds a
        // 64x64 PNG with the fitted image letterboxed at y = 8.
        let spans = parse_psd_spans(&written).unwrap();
        let record = spans
            .records
            .iter()
            .find(|r| r.name == "embedded-png")
            .unwrap();
        let uuid = smart_object_uuid(&written, record).unwrap();
        assert_eq!(uuid, "5a96c404-ab9c-1177-97ef-96ca454b82b7");
        let item = find_linked_item(&written, &spans, &uuid).unwrap();
        assert_eq!(
            &written[item.filetype_offset..item.filetype_offset + 4],
            b"png "
        );
        let embedded = &written[item.data_range.0..item.data_range.1];
        let decoded = image::load_from_memory(embedded).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (64, 64));
        assert_eq!(decoded.get_pixel(0, 0).0, [0, 0, 0, 0]); // letterbox strip
        assert_eq!(decoded.get_pixel(0, 16).0, [10, 200, 30, 255]);
        assert_eq!(decoded.get_pixel(63, 55).0, [10, 200, 30, 255]);

        // The other linked items are untouched.
        let other = find_linked_item(&written, &spans, "5a96c402-ab9c-1177-97ef-96ca454b82b7");
        assert!(other.is_err()); // external item: not an embedded (liFD) one

        // Metadata mirrors the Python CLI's replace_content run.
        let metadata: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("final_metadata.json")).unwrap())
                .unwrap();
        assert_eq!(metadata["smart_object_mode"], "replace_content");
        assert_eq!(metadata["placeholder_kind"], "smartobject");
        assert_eq!(metadata["generated_layer"], "embedded-png");
        assert_eq!(metadata["fit_offset"], serde_json::json!([0, 8]));
        assert_eq!(
            metadata["placeholder"],
            serde_json::json!({"left": 96, "top": 96, "width": 64, "height": 64})
        );

        // Preview parity with the Python CLI inside the fitted region. (In
        // the letterbox strips the native raster keeps the PNG's transparency
        // — matching what Photoshop re-renders — while the legacy bridge
        // flattens them to opaque RGB, so the strips are excluded.)
        let native = image::load_from_memory(&fs::read(dir.join("final_preview.png")).unwrap())
            .unwrap()
            .to_rgb8();
        let python = image::load_from_memory(PYTHON_PREVIEW).unwrap().to_rgb8();
        assert_eq!(native.dimensions(), python.dimensions());
        for y in 0..python.height() {
            for x in 0..python.width() {
                let in_strip =
                    (96..160).contains(&x) && ((96..104).contains(&y) || (152..160).contains(&y));
                if in_strip {
                    continue;
                }
                // The template's semi-transparent smart-object edges round
                // differently in psd_tools' integer compositor, so allow a
                // ±1 per-channel tolerance.
                let native = native.get_pixel(x, y).0;
                let python = python.get_pixel(x, y).0;
                for channel in 0..3 {
                    assert!(
                        native[channel].abs_diff(python[channel]) <= 1,
                        "preview differs at ({x}, {y}): {native:?} vs {python:?}"
                    );
                }
            }
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replaced_psd_bytes_outside_spliced_spans_are_preserved() {
        let original = fs::read(TEMPLATE).unwrap();
        let (dir, _) = run("bytes");
        let written = fs::read(dir.join("final.psd")).unwrap();

        // Header through the layer & mask length field is untouched, and the
        // merged image data section at the end is byte-identical.
        let spans = parse_psd_spans(&original).unwrap();
        assert_eq!(
            &written[..spans.layer_mask_len_offset],
            &original[..spans.layer_mask_len_offset]
        );
        let orig_tail = &original[spans.layer_mask_end..];
        assert_eq!(&written[written.len() - orig_tail.len()..], orig_tail);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn external_smart_object_is_an_error() {
        let dir = out_dir("external");
        let err = compose_psd_native(&ComposeArgs {
            template: TEMPLATE,
            image: GENERATED,
            mask: "",
            output_dir: dir.to_str().unwrap(),
            filename: "final",
            placeholder: r#"{"name": "linked-png"}"#,
            fit_mode: "contain",
            z_order: "above_background",
            smart_object_mode: "replace_content",
            hide_placeholder: true,
            metadata: "{}",
            save_preview: true,
        })
        .map(|result| result.status)
        .unwrap_err();
        assert!(err.contains("legacy bridge required"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn disable_mode_still_inserts_pixel_layer_over_smart_object() {
        let dir = out_dir("disable");
        let result = compose_psd_native(&ComposeArgs {
            template: TEMPLATE,
            image: GENERATED,
            mask: "",
            output_dir: dir.to_str().unwrap(),
            filename: "final",
            placeholder: r#"{"name": "embedded-png"}"#,
            fit_mode: "contain",
            z_order: "above_background",
            smart_object_mode: "disable",
            hide_placeholder: true,
            metadata: "{}",
            save_preview: false,
        })
        .expect("pixel-layer route still works on smart-object placeholders");
        assert_eq!(result.smart_object_mode, "disable");
        let written = fs::read(dir.join("final.psd")).unwrap();
        let parsed = parse_psd_full(&written).unwrap();
        let names: Vec<&str> = parsed.tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Background",
                "03_GENERATED",
                "linked-png",
                "linked-psd",
                "embedded-png"
            ]
        );
        assert!(!parsed.tree[4].visible); // placeholder hidden
        let _ = fs::remove_dir_all(&dir);
    }
}
