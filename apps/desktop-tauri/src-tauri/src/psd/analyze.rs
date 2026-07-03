//! Native PSD context analysis: the Rust default behind the
//! `analyze_psd_context` command (the **PSD Context Analyze** node), ported
//! 1:1 from `python/bridge/analyze_psd_cli.py`.
//!
//! It decodes only the pixels it needs from the template parsed by
//! `super::inspect` — the named background layer's own channels when given, or
//! the merged (composite) image data section otherwise — and reproduces the
//! CLI's Phase-1 heuristics exactly: alpha-weighted mean colour / brightness /
//! contrast, a median-cut dominant palette, the 3x3 brightest-cell light
//! direction, the red/blue colour-temperature estimate, and the same
//! `description` / `prompt_suffix` strings. It writes the same three artifact
//! PNGs (placeholder mask, background preview, luminance histogram) with the
//! same file names.
//!
//! Scope: 8-bit RGB PSD/PSB with raw or RLE channel compression — the subset
//! `psd_tools` writes and real product templates use. Anything else returns an
//! error so the command can fall back to the optional legacy Python bridge.

use std::fs;
use std::path::Path;

use image::{GrayImage, Rgba, RgbaImage};

use super::inspect::{parse_psd_full, ChannelRef, LayerNode, ParsedPsd};
use crate::contracts::{
    BackgroundContext, Bounds, LightingContext, PlaceholderContext, VisualContext,
};

const EPS: f64 = 1e-6;
/// Alpha at/above this 0..1 fraction counts a background pixel as "present"
/// for the dominant-palette median cut (mirrors `_OPAQUE_FRACTION`).
const OPAQUE_FRACTION: f64 = 0.5;

/// The 3x3 grid cells, row-major, mapped to a light-direction label.
const DIRECTIONS: [&str; 9] = [
    "top-left",
    "top",
    "top-right",
    "left",
    "center",
    "right",
    "bottom-left",
    "bottom",
    "bottom-right",
];

/// Python's `round()` (banker's rounding, half-to-even) for integral results.
fn round_half_even(value: f64) -> f64 {
    let floor = value.floor();
    let diff = value - floor;
    if (diff - 0.5).abs() < f64::EPSILON {
        if (floor as i64) % 2 == 0 {
            floor
        } else {
            floor + 1.0
        }
    } else {
        value.round()
    }
}

/// Python's `round(value, 4)`.
fn round4(value: f64) -> f64 {
    round_half_even(value * 10_000.0) / 10_000.0
}

/// A filesystem-safe base name derived from the template file stem
/// (mirrors `_safe_stem`).
fn safe_stem(template_path: &str) -> String {
    let stem = Path::new(template_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let cleaned: String = stem
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "template".to_string()
    } else {
        cleaned
    }
}

fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

/// Decode one channel data block (compression u16 + payload) into
/// `width*height` bytes. Supports raw (0) and PackBits RLE (1); zip variants
/// return an error so the caller can fall back to the legacy bridge.
fn decode_channel(
    data: &[u8],
    channel: &ChannelRef,
    width: usize,
    height: usize,
    psb: bool,
) -> Result<Vec<u8>, String> {
    let block = data
        .get(channel.offset..channel.offset + channel.len)
        .ok_or("channel data out of bounds")?;
    if block.len() < 2 {
        return Err("channel data block too short".to_string());
    }
    let compression = u16::from_be_bytes([block[0], block[1]]);
    let payload = &block[2..];
    match compression {
        0 => {
            let need = width * height;
            if payload.len() < need {
                return Err("raw channel data truncated".to_string());
            }
            Ok(payload[..need].to_vec())
        }
        1 => decode_rle_rows(payload, width, height, psb),
        other => Err(format!(
            "unsupported channel compression {other} (zip); legacy bridge required"
        )),
    }
}

/// Decode PackBits RLE: a per-row byte-count table (u16 per row, u32 in PSB)
/// followed by the packed rows.
fn decode_rle_rows(
    payload: &[u8],
    width: usize,
    height: usize,
    psb: bool,
) -> Result<Vec<u8>, String> {
    let count_size = if psb { 4 } else { 2 };
    let table_len = height * count_size;
    if payload.len() < table_len {
        return Err("RLE row table truncated".to_string());
    }
    let mut out = Vec::with_capacity(width * height);
    let mut offset = table_len;
    for row in 0..height {
        let base = row * count_size;
        let count = if psb {
            u32::from_be_bytes(payload[base..base + 4].try_into().unwrap()) as usize
        } else {
            u16::from_be_bytes(payload[base..base + 2].try_into().unwrap()) as usize
        };
        let row_data = payload
            .get(offset..offset + count)
            .ok_or("RLE row data truncated")?;
        offset += count;
        unpack_bits(row_data, width, &mut out)?;
    }
    Ok(out)
}

/// PackBits decompression of one row into exactly `width` bytes.
fn unpack_bits(row: &[u8], width: usize, out: &mut Vec<u8>) -> Result<(), String> {
    let start = out.len();
    let mut pos = 0usize;
    while pos < row.len() && out.len() - start < width {
        let header = row[pos] as i8;
        pos += 1;
        if header >= 0 {
            let count = header as usize + 1;
            let literal = row
                .get(pos..pos + count)
                .ok_or("PackBits literal truncated")?;
            out.extend_from_slice(literal);
            pos += count;
        } else if header != -128 {
            let count = 1 - header as isize;
            let value = *row.get(pos).ok_or("PackBits repeat truncated")?;
            pos += 1;
            out.extend(std::iter::repeat(value).take(count as usize));
        }
    }
    if out.len() - start != width {
        return Err("PackBits row length mismatch".to_string());
    }
    Ok(())
}

/// Decode a pixel layer's own channels into an RGBA image at its bbox size
/// (the native equivalent of psd_tools `layer.composite().convert("RGBA")`).
fn layer_rgba(data: &[u8], parsed: &ParsedPsd, node: &LayerNode) -> Result<RgbaImage, String> {
    let (left, top, right, bottom) = node.bbox();
    let width = (right - left).max(0) as usize;
    let height = (bottom - top).max(0) as usize;
    if width == 0 || height == 0 {
        return Err("background layer has an empty bbox".to_string());
    }
    let mut planes: [Option<Vec<u8>>; 4] = [None, None, None, None];
    for channel in &node.channels {
        let slot = match channel.id {
            0 => 0,
            1 => 1,
            2 => 2,
            -1 => 3,
            _ => continue, // layer mask (-2) and friends: not needed here
        };
        planes[slot] = Some(decode_channel(data, channel, width, height, parsed.psb)?);
    }
    let [r, g, b, a] = planes;
    let (r, g, b) = match (r, g, b) {
        (Some(r), Some(g), Some(b)) => (r, g, b),
        _ => return Err("background layer is missing RGB channels".to_string()),
    };
    let mut image = RgbaImage::new(width as u32, height as u32);
    for (index, pixel) in image.pixels_mut().enumerate() {
        let alpha = a.as_ref().map_or(255, |plane| plane[index]);
        *pixel = Rgba([r[index], g[index], b[index], alpha]);
    }
    Ok(image)
}

/// A layer the simple compositor can handle faithfully: normal blend mode at
/// full opacity, no clipping, no layer mask. Anything else needs the real
/// blending engine and falls back to the legacy bridge.
fn require_plain(node: &LayerNode) -> Result<(), String> {
    if &node.blend != b"norm" || node.opacity != 255 || node.clipping != 0 {
        return Err(format!(
            "layer '{}' uses non-trivial blending; legacy bridge required",
            node.name
        ));
    }
    if node.channels.iter().any(|channel| channel.id == -2) {
        return Err(format!(
            "layer '{}' has a layer mask; legacy bridge required",
            node.name
        ));
    }
    Ok(())
}

/// Re-composite the visible layers bottom-to-top — the native equivalent of
/// psd_tools `psd.composite().convert("RGBA")`, which blends over a white
/// backdrop and returns an opaque image. Restricted to plain normal-mode
/// layers (see [`require_plain`]).
fn composite_rgba(data: &[u8], parsed: &ParsedPsd) -> Result<RgbaImage, String> {
    let width = parsed.width as usize;
    let height = parsed.height as usize;
    // Premultiplied f64 accumulation: [r*a, g*a, b*a, a] per pixel, 0..1.
    let mut canvas = vec![[0f64; 4]; width * height];

    fn blend_tree(
        data: &[u8],
        parsed: &ParsedPsd,
        nodes: &[LayerNode],
        canvas: &mut [[f64; 4]],
        width: usize,
        height: usize,
    ) -> Result<(), String> {
        for node in nodes {
            if !node.visible {
                continue;
            }
            if node.kind == "group" {
                require_plain(node)?;
                blend_tree(data, parsed, &node.children, canvas, width, height)?;
                continue;
            }
            require_plain(node)?;
            let (left, top, right, bottom) = node.bbox();
            if right <= left || bottom <= top {
                continue;
            }
            let layer = layer_rgba(data, parsed, node)?;
            for (y_off, row) in layer.rows().enumerate() {
                let y = top as i64 + y_off as i64;
                if y < 0 || y >= height as i64 {
                    continue;
                }
                for (x_off, pixel) in row.enumerate() {
                    let x = left as i64 + x_off as i64;
                    if x < 0 || x >= width as i64 {
                        continue;
                    }
                    let sa = f64::from(pixel[3]) / 255.0;
                    if sa <= 0.0 {
                        continue;
                    }
                    let target = &mut canvas[y as usize * width + x as usize];
                    let inv = 1.0 - sa;
                    for ch in 0..3 {
                        target[ch] = f64::from(pixel[ch]) / 255.0 * sa + target[ch] * inv;
                    }
                    target[3] = sa + target[3] * inv;
                }
            }
        }
        Ok(())
    }
    blend_tree(data, parsed, &parsed.tree, &mut canvas, width, height)?;

    let mut image = RgbaImage::new(parsed.width, parsed.height);
    for (index, pixel) in image.pixels_mut().enumerate() {
        let [pr, pg, pb, alpha] = canvas[index];
        // Blend the premultiplied colour over the white backdrop and drop
        // transparency, like psd_tools' default `composite(color=1.0)`.
        let over_white = |value: f64| -> u8 {
            ((value + (1.0 - alpha)) * 255.0).round().clamp(0.0, 255.0) as u8
        };
        *pixel = Rgba([over_white(pr), over_white(pg), over_white(pb), 255]);
    }
    Ok(image)
}

/// Recursively find a layer by name in the tree, matching `_find_layer`'s
/// traversal order (each level in file order, descending into groups).
fn find_layer<'tree>(tree: &'tree [LayerNode], name: &str) -> Option<&'tree LayerNode> {
    for node in tree {
        if node.name == name {
            return Some(node);
        }
        if node.kind == "group" {
            if let Some(found) = find_layer(&node.children, name) {
                return Some(found);
            }
        }
    }
    None
}

/// Resolve the placeholder geometry, mirroring
/// `HGripePsdCompose._resolve_placeholder` for the analyze case (name-only
/// plan): a named layer's bbox (whole canvas when degenerate), or the whole
/// canvas when no name is given.
fn resolve_placeholder(
    parsed: &ParsedPsd,
    target_name: &str,
) -> Result<(i64, i64, i64, i64), String> {
    let canvas_w = i64::from(parsed.width);
    let canvas_h = i64::from(parsed.height);
    if target_name.is_empty() {
        return Ok((0, 0, canvas_w, canvas_h));
    }
    let layer = find_layer(&parsed.tree, target_name)
        .ok_or_else(|| format!("placeholder layer '{target_name}' was not found in template"))?;
    let (left, top, right, bottom) = layer.bbox();
    let (box_w, box_h) = (i64::from(right - left), i64::from(bottom - top));
    if box_w <= 0 || box_h <= 0 {
        return Ok((i64::from(left), i64::from(top), canvas_w, canvas_h));
    }
    Ok((i64::from(left), i64::from(top), box_w, box_h))
}

/// Rec.601 luma of one pixel, 0..255.
fn luminance(pixel: &Rgba<u8>) -> f64 {
    f64::from(pixel[0]) * 0.299 + f64::from(pixel[1]) * 0.587 + f64::from(pixel[2]) * 0.114
}

/// Top-5 dominant colours via median-cut quantisation of the sufficiently
/// opaque pixels, most frequent first (mirrors `_dominant_palette`). With few
/// distinct colours this matches PIL's median cut exactly; on complex images
/// the split heuristics may pick slightly different representatives.
fn dominant_palette(image: &RgbaImage, count: usize) -> Vec<String> {
    let mut pixels: Vec<[u8; 3]> = image
        .pixels()
        .filter(|pixel| f64::from(pixel[3]) / 255.0 >= OPAQUE_FRACTION)
        .map(|pixel| [pixel[0], pixel[1], pixel[2]])
        .collect();
    if pixels.is_empty() {
        pixels = image
            .pixels()
            .map(|pixel| [pixel[0], pixel[1], pixel[2]])
            .collect();
    }

    // Frequency map of distinct colours.
    let mut freq = std::collections::HashMap::new();
    for pixel in &pixels {
        *freq.entry(*pixel).or_insert(0usize) += 1;
    }
    let boxes_wanted = count.max(2);
    if freq.len() <= boxes_wanted {
        let mut entries: Vec<([u8; 3], usize)> = freq.into_iter().collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1));
        return entries
            .into_iter()
            .take(count)
            .map(|(rgb, _)| hex(rgb))
            .collect();
    }

    // Median cut: repeatedly split the box with the largest channel range.
    struct ColorBox {
        colors: Vec<([u8; 3], usize)>,
        population: usize,
    }
    impl ColorBox {
        fn new(colors: Vec<([u8; 3], usize)>) -> Self {
            let population = colors.iter().map(|(_, n)| n).sum();
            Self { colors, population }
        }
        fn widest_channel(&self) -> (usize, u8) {
            let mut best = (0, 0u8);
            for ch in 0..3 {
                let min = self.colors.iter().map(|(c, _)| c[ch]).min().unwrap_or(0);
                let max = self.colors.iter().map(|(c, _)| c[ch]).max().unwrap_or(0);
                let range = max - min;
                if range > best.1 {
                    best = (ch, range);
                }
            }
            best
        }
    }
    let mut boxes = vec![ColorBox::new(freq.into_iter().collect())];
    while boxes.len() < boxes_wanted {
        let (index, _) = match boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.colors.len() > 1)
            .max_by_key(|(_, b)| b.widest_channel().1)
        {
            Some((index, b)) => (index, b),
            None => break,
        };
        let mut split = boxes.swap_remove(index);
        let (ch, _) = split.widest_channel();
        split.colors.sort_by_key(|(c, _)| c[ch]);
        // Split at the population median.
        let half = split.population / 2;
        let mut acc = 0usize;
        let mut cut = split.colors.len() - 1;
        for (i, (_, n)) in split.colors.iter().enumerate() {
            acc += n;
            if acc >= half {
                cut = (i + 1).min(split.colors.len() - 1).max(1);
                break;
            }
        }
        let right = split.colors.split_off(cut);
        boxes.push(ColorBox::new(split.colors));
        boxes.push(ColorBox::new(right));
    }
    boxes.sort_by(|a, b| b.population.cmp(&a.population));
    boxes
        .into_iter()
        .take(count)
        .map(|b| {
            // Population-weighted average colour of the box.
            let total = b.population.max(1) as f64;
            let mut sum = [0f64; 3];
            for (c, n) in &b.colors {
                for ch in 0..3 {
                    sum[ch] += f64::from(c[ch]) * (*n as f64);
                }
            }
            hex([
                (sum[0] / total).round().clamp(0.0, 255.0) as u8,
                (sum[1] / total).round().clamp(0.0, 255.0) as u8,
                (sum[2] / total).round().clamp(0.0, 255.0) as u8,
            ])
        })
        .collect()
}

/// Brightest cell of an alpha-weighted 3x3 grid -> direction + spread
/// (mirrors `_light_direction`).
fn light_direction(image: &RgbaImage, uniform_weight: bool) -> (String, f64) {
    let height = image.height() as usize;
    let width = image.width() as usize;
    if height == 0 || width == 0 {
        return ("center".to_string(), 0.0);
    }
    // np.linspace(0, n, 4).astype(int): truncated thirds.
    let bounds = |n: usize| -> [usize; 4] {
        [
            0,
            (n as f64 / 3.0) as usize,
            (n as f64 * 2.0 / 3.0) as usize,
            n,
        ]
    };
    let ys = bounds(height);
    let xs = bounds(width);
    let mut cells = [0f64; 9];
    let mut valid = [false; 9];
    for j in 0..3 {
        for i in 0..3 {
            let mut weighted = 0f64;
            let mut total = 0f64;
            for y in ys[j]..ys[j + 1] {
                for x in xs[i]..xs[i + 1] {
                    let pixel = image.get_pixel(x as u32, y as u32);
                    let weight = if uniform_weight {
                        1.0
                    } else {
                        f64::from(pixel[3]) / 255.0
                    };
                    weighted += luminance(pixel) * weight;
                    total += weight;
                }
            }
            let cell = j * 3 + i;
            if total > EPS {
                cells[cell] = weighted / total;
                valid[cell] = true;
            }
        }
    }
    let lit: Vec<usize> = (0..9).filter(|&i| valid[i]).collect();
    if lit.is_empty() {
        return ("center".to_string(), 0.0);
    }
    let brightest = *lit
        .iter()
        .max_by(|&&a, &&b| cells[a].partial_cmp(&cells[b]).unwrap())
        .unwrap();
    let values: Vec<f64> = lit.iter().map(|&i| cells[i]).collect();
    let spread = (values.iter().cloned().fold(f64::MIN, f64::max)
        - values.iter().cloned().fold(f64::MAX, f64::min))
        / 255.0;
    let direction = if spread < 0.08 {
        "center"
    } else {
        DIRECTIONS[brightest]
    };
    (direction.to_string(), spread)
}

/// Rough correlated colour temperature from the red/blue balance
/// (mirrors `_color_temperature`).
fn color_temperature(mean_rgb: [f64; 3]) -> u32 {
    let red = mean_rgb[0] + 1.0;
    let blue = mean_rgb[2] + 1.0;
    let kelvin = (2000.0 + (blue / red) * 4500.0).clamp(2000.0, 12000.0);
    (round_half_even(kelvin / 100.0) * 100.0) as u32
}

fn warmth_label(kelvin: u32) -> &'static str {
    if kelvin < 4500 {
        "warm"
    } else if kelvin > 6500 {
        "cool"
    } else {
        "neutral"
    }
}

/// Render the alpha-weighted 256-bin luminance histogram as a small PNG
/// (mirrors `_write_histogram`).
fn write_histogram(image: &RgbaImage, uniform_weight: bool, path: &Path) -> Result<(), String> {
    let mut hist = [0f64; 256];
    for pixel in image.pixels() {
        let weight = if uniform_weight {
            1.0
        } else {
            f64::from(pixel[3]) / 255.0
        };
        let bin = round_half_even(luminance(pixel)).clamp(0.0, 255.0) as usize;
        hist[bin] += weight;
    }
    let peak = hist.iter().cloned().fold(0.0, f64::max);
    let (width, height) = (256u32, 100u32);
    let mut canvas = RgbaImage::from_pixel(width, height, Rgba([24, 24, 24, 255]));
    if peak > EPS {
        for x in 0..256usize {
            let bar = round_half_even(hist[x] / peak * f64::from(height - 1)) as u32;
            if bar > 0 {
                // PIL's line() paints both endpoints: bar+1 pixels.
                for y in 0..=bar {
                    canvas.put_pixel(x as u32, height - 1 - y, Rgba([220, 220, 220, 255]));
                }
            }
        }
    }
    image::DynamicImage::ImageRgba8(canvas)
        .to_rgb8()
        .save(path)
        .map_err(|err| format!("failed to write {}: {err}", path.display()))
}

/// Run the native PSD context analysis. Mirrors `analyze_psd_cli.py`'s
/// `analyze()` exactly; any unsupported input (non-RGB/8-bit, zip channels, a
/// missing merged composite) returns `Err` so the caller can fall back to the
/// optional legacy Python bridge.
pub(crate) fn analyze_psd_native(
    template: &str,
    background_layer: &str,
    target_placeholder: &str,
    output_dir: &str,
) -> Result<VisualContext, String> {
    let template_path = Path::new(template);
    let data = fs::read(template_path)
        .map_err(|err| format!("failed to read {}: {err}", template_path.display()))?;
    let parsed = parse_psd_full(&data)?;
    if parsed.color_mode != 3 || parsed.depth != 8 {
        return Err(format!(
            "unsupported PSD color mode {} / depth {} (native path handles 8-bit RGB)",
            parsed.color_mode, parsed.depth
        ));
    }
    let canvas_w = i64::from(parsed.width);
    let canvas_h = i64::from(parsed.height);

    // --- Placeholder geometry.
    let target_name = target_placeholder.trim();
    let (left, top, box_w, box_h) = resolve_placeholder(&parsed, target_name)?;
    let margin_x = round_half_even(box_w as f64 * 0.05) as i64;
    let margin_y = round_half_even(box_h as f64 * 0.05) as i64;
    let safe_area = Bounds {
        x: left + margin_x,
        y: top + margin_y,
        width: (box_w - 2 * margin_x).max(0),
        height: (box_h - 2 * margin_y).max(0),
    };

    // --- Background selection: the named layer's own pixels when given and
    // found (like `layer.composite()`), else the merged composite. A group or
    // a masked layer needs real re-compositing, which only the legacy bridge
    // does; error out so the command can fall back.
    let background_name = background_layer.trim();
    let background = match find_layer(&parsed.tree, background_name) {
        Some(node) if !background_name.is_empty() => {
            if node.kind == "group" {
                return Err(format!(
                    "background layer '{background_name}' is a group; legacy bridge required"
                ));
            }
            if node.channels.iter().any(|channel| channel.id == -2) {
                return Err(format!(
                    "background layer '{background_name}' has a layer mask; legacy bridge required"
                ));
            }
            layer_rgba(&data, &parsed, node)?
        }
        _ => composite_rgba(&data, &parsed)?,
    };

    // --- Alpha-weighted statistics.
    let alpha_total: f64 = background
        .pixels()
        .map(|pixel| f64::from(pixel[3]) / 255.0)
        .sum();
    let uniform_weight = alpha_total <= EPS;
    let weight_of = |pixel: &Rgba<u8>| -> f64 {
        if uniform_weight {
            1.0
        } else {
            f64::from(pixel[3]) / 255.0
        }
    };
    let wsum: f64 = background.pixels().map(&weight_of).sum();

    let mut mean_rgb = [0f64; 3];
    let mut mean_gray_acc = 0f64;
    for pixel in background.pixels() {
        let weight = weight_of(pixel);
        for ch in 0..3 {
            mean_rgb[ch] += f64::from(pixel[ch]) * weight;
        }
        mean_gray_acc += luminance(pixel) * weight;
    }
    for ch in &mut mean_rgb {
        *ch /= wsum;
    }
    let mean_color = [
        round_half_even(mean_rgb[0]).clamp(0.0, 255.0) as u8,
        round_half_even(mean_rgb[1]).clamp(0.0, 255.0) as u8,
        round_half_even(mean_rgb[2]).clamp(0.0, 255.0) as u8,
    ];
    let mean_gray = mean_gray_acc / wsum;
    let brightness = round4(mean_gray / 255.0);
    let variance: f64 = background
        .pixels()
        .map(|pixel| (luminance(pixel) - mean_gray).powi(2) * weight_of(pixel))
        .sum::<f64>()
        / wsum;
    let contrast = round4((variance.sqrt() / 128.0).min(1.0));

    let palette = dominant_palette(&background, 5);
    let kelvin = color_temperature(mean_rgb);
    let (direction, spread) = light_direction(&background, uniform_weight);
    let quality = if spread >= 0.35 || contrast >= 0.45 {
        "hard"
    } else {
        "soft"
    };
    let warmth = warmth_label(kelvin);
    let description = format!(
        "{warmth} background with {quality} key light from {direction}, \
         color temperature {kelvin}k"
    );
    let prompt_suffix = format!(
        "matched with the PSD background lighting: {quality} key light from {direction}, \
         {warmth} background, color temperature {kelvin}k, \
         realistic contact shadow, consistent highlight direction, no floating object"
    );

    // --- Written artifacts: placeholder mask + background preview + histogram.
    let directory = if output_dir.trim().is_empty() {
        Path::new(".")
    } else {
        Path::new(output_dir.trim())
    };
    fs::create_dir_all(directory)
        .map_err(|err| format!("failed to create {}: {err}", directory.display()))?;
    let stem = safe_stem(template);

    let mut mask = GrayImage::new(parsed.width, parsed.height);
    if box_w > 0 && box_h > 0 {
        for y in top.max(0)..(top + box_h).min(canvas_h) {
            for x in left.max(0)..(left + box_w).min(canvas_w) {
                mask.put_pixel(x as u32, y as u32, image::Luma([255]));
            }
        }
    }
    let mask_path = directory.join(format!("{stem}_placeholder_mask.png"));
    mask.save(&mask_path)
        .map_err(|err| format!("failed to write {}: {err}", mask_path.display()))?;

    let background_path = directory.join(format!("{stem}_background.png"));
    background
        .save(&background_path)
        .map_err(|err| format!("failed to write {}: {err}", background_path.display()))?;

    let histogram_path = directory.join(format!("{stem}_histogram.png"));
    write_histogram(&background, uniform_weight, &histogram_path)?;

    Ok(VisualContext {
        background: BackgroundContext {
            mean_color,
            dominant_palette: palette,
            brightness,
            contrast,
            histogram_path: Some(histogram_path.to_string_lossy().to_string()),
            image_path: Some(background_path.to_string_lossy().to_string()),
        },
        lighting: LightingContext {
            direction,
            quality: quality.to_string(),
            color_temperature: kelvin,
            description,
        },
        placeholder: PlaceholderContext {
            layer_name: target_name.to_string(),
            bounds: Bounds {
                x: left,
                y: top,
                width: box_w,
                height: box_h,
            },
            mask_path: Some(mask_path.to_string_lossy().to_string()),
            safe_area: Some(safe_area),
        },
        prompt_suffix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same synthetic fixture `super::inspect` tests against; the expected
    /// values below are the golden output of `analyze_psd_cli.py` on this file
    /// (see the PR that introduced them).
    fn fixture_path() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("inspect_template.psd")
    }

    /// A unique per-test output directory under the OS temp dir (removed on
    /// drop), avoiding a `tempfile` dev-dependency.
    struct TempOut(std::path::PathBuf);
    impl TempOut {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("hgripe_analyze_test_{tag}_{}", std::process::id()));
            fs::create_dir_all(&dir).expect("create temp output dir");
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempOut {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn full_composite_matches_python_golden_output() {
        let out = TempOut::new("full");
        let context = analyze_psd_native(
            fixture_path().to_str().unwrap(),
            "",
            "",
            out.path().to_str().unwrap(),
        )
        .expect("native analyze must succeed");

        assert_eq!(context.background.mean_color, [255, 255, 247]);
        assert_eq!(
            context.background.dominant_palette,
            vec!["#ffffff", "#ffff00"]
        );
        assert!((context.background.brightness - 0.9963).abs() < 5e-4);
        assert!((context.background.contrast - 0.0403).abs() < 5e-4);
        assert_eq!(context.lighting.direction, "center");
        assert_eq!(context.lighting.quality, "soft");
        assert_eq!(context.lighting.color_temperature, 6400);
        assert_eq!(
            context.lighting.description,
            "neutral background with soft key light from center, color temperature 6400k"
        );
        assert_eq!(context.placeholder.layer_name, "");
        let bounds = &context.placeholder.bounds;
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (0, 0, 64, 48)
        );
        let safe = context.placeholder.safe_area.as_ref().unwrap();
        assert_eq!((safe.x, safe.y, safe.width, safe.height), (3, 2, 58, 44));
        assert_eq!(
            context.prompt_suffix,
            "matched with the PSD background lighting: soft key light from center, \
             neutral background, color temperature 6400k, realistic contact shadow, \
             consistent highlight direction, no floating object"
        );
        for path in [
            context.background.histogram_path.as_deref().unwrap(),
            context.background.image_path.as_deref().unwrap(),
            context.placeholder.mask_path.as_deref().unwrap(),
        ] {
            assert!(Path::new(path).is_file(), "missing artifact {path}");
        }
    }

    #[test]
    fn named_background_and_placeholder_match_python_golden_output() {
        let out = TempOut::new("named");
        let context = analyze_psd_native(
            fixture_path().to_str().unwrap(),
            "Red",
            "Green",
            out.path().to_str().unwrap(),
        )
        .expect("native analyze must succeed");

        assert_eq!(context.background.mean_color, [255, 0, 0]);
        assert_eq!(context.background.dominant_palette, vec!["#ff0000"]);
        assert!((context.background.brightness - 0.299).abs() < 5e-4);
        assert!(context.background.contrast.abs() < 5e-4);
        assert_eq!(context.lighting.direction, "center");
        assert_eq!(context.lighting.color_temperature, 2000);
        assert_eq!(context.placeholder.layer_name, "Green");
        let bounds = &context.placeholder.bounds;
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (0, 0, 10, 10)
        );
        let safe = context.placeholder.safe_area.as_ref().unwrap();
        assert_eq!((safe.x, safe.y, safe.width, safe.height), (0, 0, 10, 10));
    }

    #[test]
    fn missing_placeholder_layer_is_an_error() {
        let out = TempOut::new("missing");
        let err = analyze_psd_native(
            fixture_path().to_str().unwrap(),
            "",
            "no-such-layer",
            out.path().to_str().unwrap(),
        )
        .map(|_| ())
        .unwrap_err();
        assert!(err.contains("was not found in template"), "{err}");
    }
}
