//! Native PSD compose: place a generated image into a PSD template's
//! placeholder as a new pixel layer and export the `<name>.psd` +
//! `<name>_preview.png` + `<name>_metadata.json` triplet — the write half of
//! the PSD migration (PYTHON_TO_RUST_MIGRATION_PLAN.md, "Phase 5"), mirroring
//! `python/bridge/compose_psd_cli.py`.
//!
//! The writer splices into the template rather than re-serialising it: every
//! byte of the original file is preserved verbatim except the layer info
//! sub-section, where a `03_GENERATED` group (end marker + pixel layer +
//! group record, matching psd_tools' record layout) is inserted at the
//! requested z-order and the section lengths/count are recomputed. Inputs the
//! writer cannot reproduce faithfully — smart-object content replacement,
//! non-PNG or colour-managed sources, non-8-bit/RGB templates — return an
//! error so the command falls back to the legacy Python bridge.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use image::imageops::FilterType;
use image::{GrayImage, RgbImage, Rgba, RgbaImage};
use serde_json::Value;

use super::compose::ComposePsdResult;
use super::inspect::{parse_psd_full, parse_psd_spans, PsdSpans, RecordSpan, MAX_DECODE_PIXELS};

/// Arguments of the `compose_psd` command, normalised to the CLI defaults.
pub(crate) struct ComposeArgs<'a> {
    pub(crate) template: &'a str,
    pub(crate) image: &'a str,
    pub(crate) mask: &'a str,
    pub(crate) output_dir: &'a str,
    pub(crate) filename: &'a str,
    pub(crate) placeholder: &'a str,
    pub(crate) fit_mode: &'a str,
    pub(crate) z_order: &'a str,
    pub(crate) smart_object_mode: &'a str,
    pub(crate) hide_placeholder: bool,
    pub(crate) metadata: &'a str,
    pub(crate) save_preview: bool,
}

/// A resolved placeholder: geometry plus, when found by name, the record
/// indices needed for z-ordering and hiding.
struct Placeholder {
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    /// `"smartobject"` / `"pixel"` like the Python CLI (groups count as pixel).
    kind: Option<&'static str>,
    /// Flat index of the placeholder's own record.
    record_index: Option<usize>,
    /// Flat index where the placeholder's subtree starts (its end marker for
    /// a group, the record itself for a layer).
    subtree_start: Option<usize>,
}

/// A placeholder element in the record-index tree (bottom-to-top order).
struct IndexNode {
    name: String,
    is_group: bool,
    smart_object: bool,
    rect: [i32; 4],
    /// Flat record index of this element's own record.
    record_index: usize,
    /// Flat record index where this element's records start (the end marker
    /// for a group).
    subtree_start: usize,
    children: Vec<IndexNode>,
}

impl IndexNode {
    /// `(left, top, right, bottom)` like psd_tools `layer.bbox`.
    fn bbox(&self) -> (i32, i32, i32, i32) {
        if !self.is_group {
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

/// Rebuild the group tree over flat record indices.
fn build_index_tree(records: &[RecordSpan]) -> Vec<IndexNode> {
    let mut stack: Vec<(Vec<IndexNode>, usize)> = vec![(Vec::new(), 0)];
    for (index, record) in records.iter().enumerate() {
        match record.divider {
            3 => stack.push((Vec::new(), index)),
            1 => {
                let (children, subtree_start) = stack.pop().unwrap_or((Vec::new(), index));
                let level = &mut stack.last_mut().expect("group stack underflow").0;
                level.push(IndexNode {
                    name: record.name.clone(),
                    is_group: true,
                    smart_object: false,
                    rect: record.rect,
                    record_index: index,
                    subtree_start,
                    children,
                });
            }
            _ => {
                stack
                    .last_mut()
                    .expect("layer stack underflow")
                    .0
                    .push(IndexNode {
                        name: record.name.clone(),
                        is_group: false,
                        smart_object: record.smart_object,
                        rect: record.rect,
                        record_index: index,
                        subtree_start: index,
                        children: Vec::new(),
                    });
            }
        }
    }
    let mut tree = Vec::new();
    for (level, _) in stack {
        tree.extend(level);
    }
    tree
}

/// Depth-first search matching the Python `_find_layer` order: at each level
/// (bottom-to-top) check the name first, then descend into groups.
fn find_node<'a>(nodes: &'a [IndexNode], name: &str) -> Option<&'a IndexNode> {
    for node in nodes {
        if node.name == name {
            return Some(node);
        }
        if node.is_group {
            if let Some(found) = find_node(&node.children, name) {
                return Some(found);
            }
        }
    }
    None
}

/// Resolve the placeholder plan (by layer name or explicit box), mirroring
/// `HGripePsdCompose._resolve_placeholder`.
fn resolve_placeholder(
    plan: &serde_json::Map<String, Value>,
    tree: &[IndexNode],
    canvas_w: i32,
    canvas_h: i32,
) -> Result<Placeholder, String> {
    if let Some(name) = plan.get("name").and_then(Value::as_str) {
        let name = name.trim();
        if !name.is_empty() {
            let node = find_node(tree, name)
                .ok_or_else(|| format!("placeholder layer '{name}' was not found in template"))?;
            let (left, top, right, bottom) = node.bbox();
            let (mut box_w, mut box_h) = (right - left, bottom - top);
            if box_w <= 0 || box_h <= 0 {
                (box_w, box_h) = (canvas_w, canvas_h);
            }
            return Ok(Placeholder {
                left,
                top,
                width: box_w,
                height: box_h,
                kind: Some(if node.smart_object {
                    "smartobject"
                } else {
                    "pixel"
                }),
                record_index: Some(node.record_index),
                subtree_start: Some(node.subtree_start),
            });
        }
    }
    let int_field =
        |key: &str| -> i32 { plan.get(key).and_then(Value::as_i64).unwrap_or(0) as i32 };
    let width = int_field("width");
    let height = int_field("height");
    Ok(Placeholder {
        left: int_field("left"),
        top: int_field("top"),
        width: if width != 0 { width } else { canvas_w },
        height: if height != 0 { height } else { canvas_h },
        kind: None,
        record_index: None,
        subtree_start: None,
    })
}

/// Refuse an input larger than the decompression-bomb guard before decoding.
fn guard_decode_size(path: &str) -> Result<(), String> {
    let reader = image::ImageReader::open(path)
        .map_err(|err| format!("failed to open {path}: {err}"))?
        .with_guessed_format()
        .map_err(|err| format!("failed to probe {path}: {err}"))?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|err| format!("failed to read dimensions of {path}: {err}"))?;
    if u64::from(width) * u64::from(height) > MAX_DECODE_PIXELS {
        return Err(format!(
            "input image too large to decode safely: {path} {width}x{height} \
             ({} px > max {MAX_DECODE_PIXELS})",
            u64::from(width) * u64::from(height)
        ));
    }
    Ok(())
}

/// True when the PNG carries a chunk the native loader cannot honour (an ICC
/// profile that may need colour management, or EXIF with an orientation).
fn png_has_unsupported_chunk(data: &[u8]) -> bool {
    if data.len() < 8 || &data[..8] != b"\x89PNG\r\n\x1a\n" {
        return true; // not a PNG at all; the caller treats this as unsupported
    }
    let mut pos = 8;
    while pos + 8 <= data.len() {
        let len = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
        let kind = &data[pos + 4..pos + 8];
        if kind == b"iCCP" || kind == b"eXIf" {
            return true;
        }
        pos = match pos.checked_add(12 + len) {
            Some(next) => next,
            None => return true,
        };
    }
    false
}

/// Load the generated image as 8-bit RGBA. Only plain 8-bit PNGs are handled
/// natively (`source_mode` reports `"RGB"`/`"RGBA"`/`"L"`/`"LA"` like PIL);
/// anything needing colour management, EXIF rotation or bit-depth mapping is
/// left to the legacy bridge.
fn load_rgba(path: &str) -> Result<(RgbaImage, &'static str), String> {
    guard_decode_size(path)?;
    let data = fs::read(path).map_err(|err| format!("failed to read {path}: {err}"))?;
    if png_has_unsupported_chunk(&data) {
        return Err(format!(
            "image {path} is not a plain PNG (colour-managed/EXIF or non-PNG input); \
             legacy bridge required"
        ));
    }
    let decoded =
        image::load_from_memory(&data).map_err(|err| format!("failed to decode {path}: {err}"))?;
    let (rgba, mode) = match decoded {
        image::DynamicImage::ImageRgb8(img) => {
            (image::DynamicImage::ImageRgb8(img).to_rgba8(), "RGB")
        }
        image::DynamicImage::ImageRgba8(img) => (img, "RGBA"),
        image::DynamicImage::ImageLuma8(img) => {
            (image::DynamicImage::ImageLuma8(img).to_rgba8(), "L")
        }
        image::DynamicImage::ImageLumaA8(img) => {
            (image::DynamicImage::ImageLumaA8(img).to_rgba8(), "LA")
        }
        _ => return Err(format!("image {path} is not 8-bit; legacy bridge required")),
    };
    Ok((rgba, mode))
}

/// Load the optional matte as an 8-bit `L` image, converting colour mattes
/// with PIL's ITU-R 601-2 luma transform so the result matches `convert("L")`.
fn load_mask(path: &str) -> Result<(GrayImage, &'static str), String> {
    guard_decode_size(path)?;
    let data = fs::read(path).map_err(|err| format!("failed to read {path}: {err}"))?;
    if png_has_unsupported_chunk(&data) {
        return Err(format!(
            "mask {path} is not a plain PNG; legacy bridge required"
        ));
    }
    let decoded =
        image::load_from_memory(&data).map_err(|err| format!("failed to decode {path}: {err}"))?;
    let luma_601 = |r: u8, g: u8, b: u8| -> u8 {
        ((u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114) / 1000) as u8
    };
    let (mask, mode) = match decoded {
        image::DynamicImage::ImageLuma8(img) => (img, "L"),
        image::DynamicImage::ImageLumaA8(img) => {
            let mut out = GrayImage::new(img.width(), img.height());
            for (dst, src) in out.pixels_mut().zip(img.pixels()) {
                dst.0[0] = src.0[0];
            }
            (out, "LA")
        }
        image::DynamicImage::ImageRgb8(img) => {
            let mut out = GrayImage::new(img.width(), img.height());
            for (dst, src) in out.pixels_mut().zip(img.pixels()) {
                dst.0[0] = luma_601(src.0[0], src.0[1], src.0[2]);
            }
            (out, "RGB")
        }
        image::DynamicImage::ImageRgba8(img) => {
            let mut out = GrayImage::new(img.width(), img.height());
            for (dst, src) in out.pixels_mut().zip(img.pixels()) {
                dst.0[0] = luma_601(src.0[0], src.0[1], src.0[2]);
            }
            (out, "RGBA")
        }
        _ => return Err(format!("mask {path} is not 8-bit; legacy bridge required")),
    };
    Ok((mask, mode))
}

/// PIL `ImageChops.multiply` rounding: `round(a * b / 255)`.
fn mul255(a: u8, b: u8) -> u8 {
    let tmp = u32::from(a) * u32::from(b) + 128;
    (((tmp >> 8) + tmp) >> 8) as u8
}

/// Apply the matte as the image's alpha, multiplied into any existing alpha.
fn apply_mask(image: &mut RgbaImage, mask: &GrayImage) {
    let mask = if mask.dimensions() == image.dimensions() {
        mask.clone()
    } else {
        image::imageops::resize(mask, image.width(), image.height(), FilterType::Lanczos3)
    };
    for (pixel, m) in image.pixels_mut().zip(mask.pixels()) {
        pixel.0[3] = mul255(pixel.0[3], m.0[0]);
    }
}

/// `_fit_into_box`: return the resized image plus its offset inside the box.
fn fit_into_box(
    image: &RgbaImage,
    box_w: i32,
    box_h: i32,
    fit_mode: &str,
) -> (RgbaImage, i32, i32) {
    let box_w = box_w.max(1) as u32;
    let box_h = box_h.max(1) as u32;
    let (src_w, src_h) = image.dimensions();
    let resize = |w: u32, h: u32| -> RgbaImage {
        if (w, h) == (src_w, src_h) {
            image.clone()
        } else {
            image::imageops::resize(image, w, h, FilterType::Lanczos3)
        }
    };

    if fit_mode == "stretch" {
        return (resize(box_w, box_h), 0, 0);
    }

    if fit_mode == "cover" {
        let scale = f64::max(
            f64::from(box_w) / f64::from(src_w),
            f64::from(box_h) / f64::from(src_h),
        );
        let new_w = ((f64::from(src_w) * scale).round() as u32).max(1);
        let new_h = ((f64::from(src_h) * scale).round() as u32).max(1);
        let resized = resize(new_w, new_h);
        let crop_x = (new_w - box_w) / 2;
        let crop_y = (new_h - box_h) / 2;
        let cropped = image::imageops::crop_imm(&resized, crop_x, crop_y, box_w, box_h).to_image();
        return (cropped, 0, 0);
    }

    // contain (default)
    let scale = f64::min(
        f64::from(box_w) / f64::from(src_w),
        f64::from(box_h) / f64::from(src_h),
    );
    let new_w = ((f64::from(src_w) * scale).round() as u32).max(1);
    let new_h = ((f64::from(src_h) * scale).round() as u32).max(1);
    let resized = resize(new_w, new_h);
    (
        resized,
        (box_w as i32 - new_w as i32) / 2,
        (box_h as i32 - new_h as i32) / 2,
    )
}

/// PIL-style default blending ranges block (5 composite/channel pairs).
fn write_blending_ranges(out: &mut Vec<u8>) {
    out.extend_from_slice(&40u32.to_be_bytes());
    for _ in 0..10 {
        out.extend_from_slice(&[0x00, 0x00, 0xff, 0xff]);
    }
}

/// Pascal name padded to a multiple of 4 (including the length byte).
fn write_pascal_name(out: &mut Vec<u8>, name: &str) {
    let bytes = name.as_bytes();
    let len = bytes.len().min(255);
    out.push(len as u8);
    out.extend_from_slice(&bytes[..len]);
    let padded = (len + 1).div_ceil(4) * 4;
    out.extend(std::iter::repeat_n(0u8, padded - len - 1));
}

/// `luni` tagged block: UTF-16BE code-unit count + units.
fn write_luni_block(out: &mut Vec<u8>, name: &str) {
    let units: Vec<u16> = name.encode_utf16().collect();
    out.extend_from_slice(b"8BIM");
    out.extend_from_slice(b"luni");
    out.extend_from_slice(&((4 + units.len() * 2) as u32).to_be_bytes());
    out.extend_from_slice(&(units.len() as u32).to_be_bytes());
    for unit in units {
        out.extend_from_slice(&unit.to_be_bytes());
    }
}

/// `lsct` tagged block: 1 = open folder, 3 = end-of-group marker.
fn write_lsct_block(out: &mut Vec<u8>, kind: u32) {
    out.extend_from_slice(b"8BIM");
    out.extend_from_slice(b"lsct");
    out.extend_from_slice(&4u32.to_be_bytes());
    out.extend_from_slice(&kind.to_be_bytes());
}

/// Serialise one layer record (psd_tools layout: default blending ranges,
/// flags `0x08`, `norm` blend at full opacity).
fn write_record(
    out: &mut Vec<u8>,
    psb: bool,
    name: &str,
    rect: [i32; 4],
    channel_lens: &[(i16, u64)],
    tagged_blocks: &[u8],
) {
    for value in rect {
        out.extend_from_slice(&value.to_be_bytes());
    }
    out.extend_from_slice(&(channel_lens.len() as u16).to_be_bytes());
    for &(id, len) in channel_lens {
        out.extend_from_slice(&id.to_be_bytes());
        if psb {
            out.extend_from_slice(&len.to_be_bytes());
        } else {
            out.extend_from_slice(&(len as u32).to_be_bytes());
        }
    }
    out.extend_from_slice(b"8BIM");
    out.extend_from_slice(b"norm");
    out.push(255); // opacity
    out.push(0); // clipping
    out.push(0x08); // flags: visible, "bit 4 has useful information"
    out.push(0); // filler

    let mut extra = Vec::new();
    extra.extend_from_slice(&0u32.to_be_bytes()); // no layer mask
    write_blending_ranges(&mut extra);
    write_pascal_name(&mut extra, name);
    extra.extend_from_slice(tagged_blocks);
    out.extend_from_slice(&(extra.len() as u32).to_be_bytes());
    out.extend_from_slice(&extra);
}

/// The three records of the generated group in file order (bottom-to-top):
/// end marker, pixel layer, group record — plus their channel data blocks.
fn encode_generated_records(
    psb: bool,
    group_name: &str,
    layer_name: &str,
    rect: [i32; 4],
    layer: &RgbaImage,
) -> (Vec<u8>, Vec<u8>) {
    let mut records = Vec::new();
    let mut channel_data = Vec::new();

    // Divider/group records carry four empty raw channels (compression only).
    let empty_lens: [(i16, u64); 4] = [(-1, 2), (0, 2), (1, 2), (2, 2)];
    let empty_data = |channel_data: &mut Vec<u8>| {
        for _ in 0..4 {
            channel_data.extend_from_slice(&0u16.to_be_bytes());
        }
    };

    let mut divider_blocks = Vec::new();
    write_lsct_block(&mut divider_blocks, 3);
    write_luni_block(&mut divider_blocks, "</Layer group>");
    write_record(
        &mut records,
        psb,
        "</Layer group>",
        [0, 0, 0, 0],
        &empty_lens,
        &divider_blocks,
    );
    empty_data(&mut channel_data);

    // The pixel layer: raw (uncompressed) planes for ids -1, 0, 1, 2.
    let plane_len = u64::from(layer.width()) * u64::from(layer.height()) + 2;
    let pixel_lens: [(i16, u64); 4] = [
        (-1, plane_len),
        (0, plane_len),
        (1, plane_len),
        (2, plane_len),
    ];
    write_record(&mut records, psb, layer_name, rect, &pixel_lens, &[]);
    for id in [-1i16, 0, 1, 2] {
        let plane_index = match id {
            -1 => 3,
            other => other as usize,
        };
        channel_data.extend_from_slice(&0u16.to_be_bytes()); // raw compression
        for pixel in layer.pixels() {
            channel_data.push(pixel.0[plane_index]);
        }
    }

    let mut group_blocks = Vec::new();
    write_lsct_block(&mut group_blocks, 1);
    write_luni_block(&mut group_blocks, group_name);
    write_record(
        &mut records,
        psb,
        group_name,
        [0, 0, 0, 0],
        &empty_lens,
        &group_blocks,
    );
    empty_data(&mut channel_data);

    (records, channel_data)
}

/// Flat record index at which the new group's records are spliced in, per
/// z-order (records run bottom-to-top, so "top" means the end of the list).
fn insertion_index(
    z_order: &str,
    records: &[RecordSpan],
    placeholder_subtree_start: Option<usize>,
) -> usize {
    if z_order == "placeholder" {
        if let Some(start) = placeholder_subtree_start {
            return start;
        }
    }
    if z_order == "above_background" {
        // After the first top-level element (psd.insert(min(1, len(psd)))).
        let mut depth = 0usize;
        for (index, record) in records.iter().enumerate() {
            match record.divider {
                3 => depth += 1,
                1 => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return index + 1;
                    }
                }
                _ => {
                    if depth == 0 {
                        return index + 1;
                    }
                }
            }
        }
        return 0;
    }
    records.len()
}

/// Reassemble the PSD with the generated group spliced into the layer info
/// sub-section (and the placeholder optionally hidden), leaving every other
/// byte of the template untouched.
fn splice_psd(
    data: &[u8],
    spans: &PsdSpans,
    insert_at: usize,
    new_records: &[u8],
    new_channel_data: &[u8],
    hide_record_index: Option<usize>,
) -> Result<Vec<u8>, String> {
    let field = |psb: bool| if psb { 8usize } else { 4 };
    let lm_field = field(spans.psb);
    let li_len_offset = spans.layer_mask_len_offset + lm_field;
    let records_start = li_len_offset + lm_field + 2;

    let first = spans
        .records
        .first()
        .map(|r| r.record_range.0)
        .unwrap_or(records_start);
    let channel_start = spans
        .records
        .first()
        .map(|r| r.channel_range.0)
        .unwrap_or(first);
    let channel_end = spans
        .records
        .last()
        .map(|r| r.channel_range.1)
        .unwrap_or(channel_start);

    // New layer info content: count + records (spliced) + channel data
    // (spliced at the matching position).
    let mut info = Vec::new();
    let old_count = spans.records.len() as i16;
    let new_count = old_count + 3;
    let signed = if spans.count_negative {
        -new_count
    } else {
        new_count
    };
    info.extend_from_slice(&signed.to_be_bytes());

    let record_split = spans
        .records
        .get(insert_at)
        .map(|r| r.record_range.0)
        .unwrap_or(channel_start);
    info.extend_from_slice(&data[records_start..record_split]);
    info.extend_from_slice(new_records);
    info.extend_from_slice(&data[record_split..channel_start]);

    let channel_split = spans
        .records
        .get(insert_at)
        .map(|r| r.channel_range.0)
        .unwrap_or(channel_end);
    info.extend_from_slice(&data[channel_start..channel_split]);
    info.extend_from_slice(new_channel_data);
    info.extend_from_slice(&data[channel_split..channel_end]);

    if info.len() % 2 != 0 {
        info.push(0);
    }

    // Hide the placeholder by setting bit 1 of its record flags inside the
    // rebuilt section (its offset shifts by the inserted records when it
    // sits above the insertion point).
    if let Some(index) = hide_record_index {
        let record = &spans.records[index];
        let base = record.flags_offset - records_start + 2; // + count field
        let offset = if index >= insert_at {
            base + new_records.len()
        } else {
            base
        };
        info[offset] |= 0x02;
    }

    // Tail of the layer & mask section (global mask info + tagged blocks).
    let tail = &data[spans.layer_info_end..spans.layer_mask_end];

    let mut out = Vec::with_capacity(data.len() + new_records.len() + new_channel_data.len());
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
    out.extend_from_slice(tail);
    out.extend_from_slice(&data[spans.layer_mask_end..]);
    Ok(out)
}

/// `datetime.now(timezone.utc).isoformat()`-style timestamp
/// (`YYYY-MM-DDTHH:MM:SS.ffffff+00:00`).
fn utc_now_isoformat() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let micros = now.subsec_micros();
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // Howard Hinnant's civil-from-days algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{micros:06}+00:00",
        tod / 3600,
        (tod / 60) % 60,
        tod % 60
    )
}

/// Render a JSON document from ordered key/value pairs the way Python's
/// `json.dumps(..., ensure_ascii=False, indent=2)` does.
fn json_pretty(pairs: &[(String, Value)]) -> String {
    fn indent_tail(text: &str) -> String {
        text.replace('\n', "\n  ")
    }
    let mut out = String::from("{");
    for (index, (key, value)) in pairs.iter().enumerate() {
        out.push_str(if index == 0 { "\n  " } else { ",\n  " });
        out.push_str(&serde_json::to_string(key).unwrap_or_default());
        out.push_str(": ");
        let rendered = serde_json::to_string_pretty(value).unwrap_or_default();
        out.push_str(&indent_tail(&rendered));
    }
    out.push_str("\n}");
    out
}

/// The native compose path behind the `compose_psd` command. Mirrors
/// `compose_psd_cli.py`'s pixel-layer route and, for `replace_content` on an
/// embedded smart object, `super::smart`'s in-place content replacement;
/// returns `Err` (so the caller can fall back to the legacy bridge) for any
/// input the writer cannot reproduce faithfully.
pub(crate) fn compose_psd_native(args: &ComposeArgs<'_>) -> Result<ComposePsdResult, String> {
    let template_path = args.template.trim();
    let image_path = args.image.trim();
    if template_path.is_empty() || !Path::new(template_path).is_file() {
        return Err(format!("PSD template not found: {template_path}"));
    }
    if image_path.is_empty() || !Path::new(image_path).is_file() {
        return Err(format!("generated image not found: {image_path}"));
    }
    let mask_path = args.mask.trim();
    if !mask_path.is_empty() && !Path::new(mask_path).is_file() {
        return Err(format!("mask not found: {mask_path}"));
    }

    let data =
        fs::read(template_path).map_err(|err| format!("failed to read {template_path}: {err}"))?;
    let spans = parse_psd_spans(&data)?;
    if spans.depth != 8 || spans.color_mode != 3 {
        return Err(format!(
            "PSD mode not supported natively (depth {}, color mode {}); legacy bridge required",
            spans.depth, spans.color_mode
        ));
    }
    let canvas_w = spans.width as i32;
    let canvas_h = spans.height as i32;

    let plan: serde_json::Map<String, Value> = if args.placeholder.trim().is_empty() {
        serde_json::Map::new()
    } else {
        match serde_json::from_str::<Value>(args.placeholder.trim()) {
            Ok(Value::Object(map)) => map,
            Ok(_) => return Err("placeholder must be a JSON object".to_string()),
            Err(err) => return Err(format!("placeholder must be valid JSON: {err}")),
        }
    };
    let tree = build_index_tree(&spans.records);
    let placeholder = resolve_placeholder(&plan, &tree, canvas_w, canvas_h)?;

    let so_replace =
        args.smart_object_mode == "replace_content" && placeholder.kind == Some("smartobject");

    let (mut generated, source_mode) = load_rgba(image_path)?;
    let image_size = [generated.width(), generated.height()];
    let mut mask_source_mode = None;
    if !mask_path.is_empty() {
        let (mask, mode) = load_mask(mask_path)?;
        mask_source_mode = Some(mode);
        apply_mask(&mut generated, &mask);
    }
    let (fitted, off_x, off_y) = fit_into_box(
        &generated,
        placeholder.width,
        placeholder.height,
        args.fit_mode,
    );
    let (composed, main_name, smart_object_mode) = if so_replace {
        // True smart-object replacement: draw the fitted image into a
        // box-sized transparent canvas (like the Python CLI's `paste`) and
        // swap both the embedded source and the cached raster in place.
        let record_index = placeholder
            .record_index
            .ok_or("smart-object placeholder has no record index")?;
        let mut boxed = RgbaImage::new(
            placeholder.width.max(1) as u32,
            placeholder.height.max(1) as u32,
        );
        image::imageops::replace(&mut boxed, &fitted, i64::from(off_x), i64::from(off_y));
        let mut png = Vec::new();
        boxed
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|err| format!("failed to encode smart-object content: {err}"))?;
        let rect = [
            placeholder.top,
            placeholder.left,
            placeholder.top + boxed.height() as i32,
            placeholder.left + boxed.width() as i32,
        ];
        let composed =
            super::smart::replace_smart_object(&data, &spans, record_index, rect, &boxed, &png)?;
        (
            composed,
            spans.records[record_index].name.clone(),
            "replace_content",
        )
    } else {
        let rect = [
            placeholder.top + off_y,
            placeholder.left + off_x,
            placeholder.top + off_y + fitted.height() as i32,
            placeholder.left + off_x + fitted.width() as i32,
        ];
        let (new_records, new_channel_data) =
            encode_generated_records(spans.psb, "03_GENERATED", "generated", rect, &fitted);
        let insert_at = insertion_index(args.z_order, &spans.records, placeholder.subtree_start);
        let hide_record_index = if args.hide_placeholder {
            placeholder.record_index
        } else {
            None
        };
        let composed = splice_psd(
            &data,
            &spans,
            insert_at,
            &new_records,
            &new_channel_data,
            hide_record_index,
        )?;
        (composed, "generated".to_string(), "disable")
    };

    // Build the preview before writing anything so an unsupported template
    // (exotic blending the native compositor rejects) falls back cleanly.
    let preview: Option<RgbImage> = if args.save_preview {
        let parsed = parse_psd_full(&composed)?;
        let rgba = super::analyze::composite_rgba(&composed, &parsed)?;
        let mut rgb = RgbImage::new(rgba.width(), rgba.height());
        for (dst, src) in rgb.pixels_mut().zip(rgba.pixels()) {
            let Rgba([r, g, b, _]) = *src;
            dst.0 = [r, g, b];
        }
        Some(rgb)
    } else {
        None
    };

    let directory = if args.output_dir.trim().is_empty() {
        PathBuf::from(".")
    } else {
        PathBuf::from(args.output_dir.trim())
    };
    fs::create_dir_all(&directory)
        .map_err(|err| format!("failed to create {}: {err}", directory.display()))?;
    let base = {
        let trimmed = args.filename.trim();
        if trimmed.is_empty() {
            "final"
        } else {
            trimmed
        }
    };

    let psd_path = directory.join(format!("{base}.psd"));
    fs::write(&psd_path, &composed)
        .map_err(|err| format!("failed to write {}: {err}", psd_path.display()))?;

    let mut preview_path = String::new();
    if let Some(preview) = preview {
        let preview_file = directory.join(format!("{base}_preview.png"));
        preview
            .save(&preview_file)
            .map_err(|err| format!("failed to write {}: {err}", preview_file.display()))?;
        preview_path = preview_file.to_string_lossy().to_string();
    }

    let mut pairs: Vec<(String, Value)> = Vec::new();
    if !args.metadata.trim().is_empty() {
        match serde_json::from_str::<Value>(args.metadata.trim()) {
            Ok(Value::Object(map)) => pairs.extend(map.into_iter()),
            Ok(_) => return Err("metadata must be a JSON object".to_string()),
            Err(err) => return Err(format!("metadata must be valid JSON: {err}")),
        }
    }
    let placeholder_kind = placeholder.kind.map(str::to_string);
    let set = |pairs: &mut Vec<(String, Value)>, key: &str, value: Value| {
        pairs.retain(|(existing, _)| existing != key);
        pairs.push((key.to_string(), value));
    };
    set(&mut pairs, "created_at", Value::from(utc_now_isoformat()));
    set(&mut pairs, "template_path", Value::from(template_path));
    set(&mut pairs, "source_image", Value::from(image_path));
    set(&mut pairs, "source_mode", Value::from(source_mode));
    set(&mut pairs, "exif_transposed", Value::from(false));
    set(&mut pairs, "image_size", Value::from(image_size.to_vec()));
    set(
        &mut pairs,
        "mask_applied",
        Value::from(!mask_path.is_empty()),
    );
    set(
        &mut pairs,
        "mask_source",
        if mask_path.is_empty() {
            Value::Null
        } else {
            Value::from(mask_path)
        },
    );
    set(
        &mut pairs,
        "mask_source_mode",
        mask_source_mode.map(Value::from).unwrap_or(Value::Null),
    );
    set(&mut pairs, "canvas", Value::from(vec![canvas_w, canvas_h]));
    let mut placeholder_obj = serde_json::Map::new();
    placeholder_obj.insert("left".to_string(), Value::from(placeholder.left));
    placeholder_obj.insert("top".to_string(), Value::from(placeholder.top));
    placeholder_obj.insert("width".to_string(), Value::from(placeholder.width));
    placeholder_obj.insert("height".to_string(), Value::from(placeholder.height));
    set(&mut pairs, "placeholder", Value::Object(placeholder_obj));
    set(
        &mut pairs,
        "placeholder_name",
        plan.get("name").cloned().unwrap_or(Value::Null),
    );
    set(
        &mut pairs,
        "placeholder_kind",
        placeholder_kind
            .clone()
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    set(
        &mut pairs,
        "generated_layer",
        Value::from(main_name.as_str()),
    );
    set(&mut pairs, "fit_mode", Value::from(args.fit_mode));
    set(&mut pairs, "fit_offset", Value::from(vec![off_x, off_y]));
    set(&mut pairs, "z_order", Value::from(args.z_order));
    set(
        &mut pairs,
        "smart_object_mode",
        Value::from(smart_object_mode),
    );
    set(
        &mut pairs,
        "psd_path",
        Value::from(psd_path.to_string_lossy().to_string()),
    );
    if !preview_path.is_empty() {
        set(
            &mut pairs,
            "preview_path",
            Value::from(preview_path.clone()),
        );
    }

    let metadata_file = directory.join(format!("{base}_metadata.json"));
    fs::write(&metadata_file, json_pretty(&pairs))
        .map_err(|err| format!("failed to write {}: {err}", metadata_file.display()))?;

    Ok(ComposePsdResult {
        status: "succeeded".to_string(),
        psd_path: psd_path.to_string_lossy().to_string(),
        preview_path,
        metadata_path: metadata_file.to_string_lossy().to_string(),
        placeholder_kind,
        smart_object_mode: smart_object_mode.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 64x48 inspect fixture (see `super::inspect::tests`).
    const TEMPLATE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/inspect_template.psd"
    );
    /// An 8x6 solid RGBA (10, 200, 30, 255) PNG — the generated image of the
    /// golden run.
    const GENERATED: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/compose_generated.png"
    );
    /// `final_preview.png` written by `compose_psd_cli.py` for the same job
    /// (template + generated image into the `Green` placeholder, contain,
    /// above_background, hide placeholder).
    const PYTHON_PREVIEW: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/compose_preview_python.png"
    ));

    fn temp_out(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("hgripe_compose_test_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn golden_args<'a>(output_dir: &'a str) -> ComposeArgs<'a> {
        ComposeArgs {
            template: TEMPLATE,
            image: GENERATED,
            mask: "",
            output_dir,
            filename: "final",
            placeholder: r#"{"name": "Green"}"#,
            fit_mode: "contain",
            z_order: "above_background",
            smart_object_mode: "disable",
            hide_placeholder: true,
            metadata: r#"{"job": "x"}"#,
            save_preview: true,
        }
    }

    /// The golden test: run the same job the Python CLI ran, re-read the
    /// written PSD with the native parser and check the layer tree matches
    /// what psd_tools produced (03_GENERATED group above the background,
    /// generated layer at the fitted rect, placeholder hidden), and the
    /// preview matches the Python preview pixel-for-pixel.
    #[test]
    fn golden_pixel_insert_matches_python_cli() {
        let out = temp_out("golden");
        let out_str = out.to_string_lossy().to_string();
        let result = compose_psd_native(&golden_args(&out_str)).expect("native compose");
        assert_eq!(result.status, "succeeded");
        assert_eq!(result.placeholder_kind.as_deref(), Some("pixel"));
        assert_eq!(result.smart_object_mode, "disable");

        let composed = fs::read(&result.psd_path).expect("psd written");
        let parsed = parse_psd_full(&composed).expect("re-parse");
        assert_eq!((parsed.width, parsed.height), (64, 48));

        // Bottom-to-top: Red, then the inserted group, then the original tree.
        let names: Vec<&str> = parsed.tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["Red", "03_GENERATED", "MyGroup", "产品图"]);
        let group = &parsed.tree[1];
        assert_eq!(group.kind, "group");
        assert!(group.visible);
        assert_eq!(group.children.len(), 1);
        let layer = &group.children[0];
        assert_eq!((layer.name.as_str(), layer.kind), ("generated", "pixel"));
        // contain-fit of 8x6 into the 10x10 Green box: 10x8 at offset (0, 1).
        assert_eq!(layer.rect, [1, 0, 9, 10]);
        assert!(layer.visible);

        // The placeholder was hidden; everything else keeps its visibility.
        let my_group = &parsed.tree[2];
        let green = my_group
            .children
            .iter()
            .find(|n| n.name == "Green")
            .expect("Green still present");
        assert!(!green.visible);
        assert!(my_group.visible);

        // Preview parity with the Python CLI output.
        let native = image::open(&result.preview_path)
            .expect("preview")
            .to_rgb8();
        let python = image::load_from_memory(PYTHON_PREVIEW)
            .expect("golden")
            .to_rgb8();
        assert_eq!(native.dimensions(), python.dimensions());
        assert!(
            native.pixels().eq(python.pixels()),
            "preview differs from the Python CLI preview"
        );

        // Metadata carries the same facts (paths/timestamps differ).
        let metadata: Value =
            serde_json::from_str(&fs::read_to_string(&result.metadata_path).unwrap()).unwrap();
        assert_eq!(metadata["job"], "x");
        assert_eq!(metadata["source_mode"], "RGBA");
        assert_eq!(metadata["image_size"], serde_json::json!([8, 6]));
        assert_eq!(metadata["canvas"], serde_json::json!([64, 48]));
        assert_eq!(
            metadata["placeholder"],
            serde_json::json!({"left": 0, "top": 0, "width": 10, "height": 10})
        );
        assert_eq!(metadata["placeholder_name"], "Green");
        assert_eq!(metadata["placeholder_kind"], "pixel");
        assert_eq!(metadata["fit_offset"], serde_json::json!([0, 1]));
        assert_eq!(metadata["smart_object_mode"], "disable");

        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn z_order_top_appends_and_placeholder_inserts_below() {
        for (z_order, expected) in [
            ("top", vec!["Red", "MyGroup", "产品图", "03_GENERATED"]),
            ("placeholder", vec!["Red", "MyGroup", "产品图"]),
        ] {
            let out = temp_out(&format!("zorder_{z_order}"));
            let out_str = out.to_string_lossy().to_string();
            let mut args = golden_args(&out_str);
            args.z_order = z_order;
            let result = compose_psd_native(&args).expect("native compose");
            let composed = fs::read(&result.psd_path).expect("psd written");
            let parsed = parse_psd_full(&composed).expect("re-parse");
            let names: Vec<&str> = parsed.tree.iter().map(|n| n.name.as_str()).collect();
            assert_eq!(names, expected, "z_order={z_order}");
            if z_order == "placeholder" {
                // The group sits just below Green, inside MyGroup.
                let my_group = &parsed.tree[1];
                let names: Vec<&str> = my_group.children.iter().map(|n| n.name.as_str()).collect();
                assert_eq!(names, vec!["03_GENERATED", "Green", "SubGroup"]);
            }
            let _ = fs::remove_dir_all(&out);
        }
    }

    #[test]
    fn missing_placeholder_name_is_an_error() {
        let out = temp_out("missing");
        let out_str = out.to_string_lossy().to_string();
        let mut args = golden_args(&out_str);
        args.placeholder = r#"{"name": "NoSuchLayer"}"#;
        let err = compose_psd_native(&args).map(|_| ()).unwrap_err();
        assert!(err.contains("was not found in template"), "{err}");
        assert!(!out.exists(), "nothing must be written on failure");
    }

    #[test]
    fn explicit_box_placeholder_without_name() {
        let out = temp_out("box");
        let out_str = out.to_string_lossy().to_string();
        let mut args = golden_args(&out_str);
        args.placeholder = r#"{"left": 4, "top": 2, "width": 16, "height": 12}"#;
        args.hide_placeholder = false;
        let result = compose_psd_native(&args).expect("native compose");
        assert_eq!(result.placeholder_kind, None);
        let composed = fs::read(&result.psd_path).expect("psd written");
        let parsed = parse_psd_full(&composed).expect("re-parse");
        let group = parsed
            .tree
            .iter()
            .find(|n| n.name == "03_GENERATED")
            .expect("group inserted");
        // contain-fit of 8x6 into 16x12 lands exactly on the box.
        assert_eq!(group.children[0].rect, [2, 4, 14, 20]);
        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn non_png_image_falls_back_to_legacy() {
        let out = temp_out("nonpng");
        let out_str = out.to_string_lossy().to_string();
        let mut args = golden_args(&out_str);
        args.image = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/cmyk_adobe_app14.jpg"
        );
        let err = compose_psd_native(&args).map(|_| ()).unwrap_err();
        assert!(err.contains("legacy bridge required"), "{err}");
    }
}
