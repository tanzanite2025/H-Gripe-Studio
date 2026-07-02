// Read-only analysers over a surface: histogram, waveform, vectorscope —
// the Resolve-style scopes the grading dialogs render. Scopes measure the
// encoded signal as displayed (values sanitised to the 0..=1 window;
// non-finite samples read as 0), never mutate the surface, and ignore
// alpha. All binning maths runs in f64 so the studio-ui mirror (plain JS
// numbers) produces bit-identical integer counts — pinned by the shared
// goldens in `goldens/scopes.json`.

use serde::{Deserialize, Serialize};

use crate::surface::GradeSurface;

/// Rec.709 luma weights in f64 (scope maths is f64 end to end).
const LUMA64: [f64; 3] = [0.2126, 0.7152, 0.0722];

/// Per-channel + luma histogram: counts of encoded values over `bins`
/// equal buckets spanning `0..=1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Histogram {
    pub bins: u32,
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
    pub luma: Vec<u32>,
}

/// Per-channel waveform: for each of `cols` columns (image columns mapped
/// proportionally), counts of encoded values over `rows` intensity buckets.
/// Row 0 is signal 0 (black), row `rows − 1` is signal 1; index
/// `row * cols + col`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Waveform {
    pub cols: u32,
    pub rows: u32,
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
}

/// Vectorscope: pixel counts over a `size × size` grid of the Rec.709
/// Cb–Cr chroma plane (`Cb = (B′ − Y′)/1.8556`, `Cr = (R′ − Y′)/1.5748`,
/// both spanning `−0.5..=0.5`). Cell `(ix, iy)` is `counts[iy * size + ix]`
/// with `ix` from Cb and `iy` from Cr; neutral grays land in the centre.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vectorscope {
    pub size: u32,
    pub counts: Vec<u32>,
}

// The displayed signal: non-finite samples read as 0, clamped to 0..=1.
fn sane01(v: f32) -> f64 {
    if v.is_finite() {
        f64::from(v).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

// Bucket index for `v` in `0..=1` over `k` buckets (`v = 1` lands in the
// last bucket).
fn bucket(v: f64, k: u32) -> usize {
    ((v * f64::from(k)) as usize).min(k as usize - 1)
}

/// Histogram of the encoded signal over `bins` buckets (`bins` floored at 1).
pub fn histogram(surface: &GradeSurface, bins: u32) -> Histogram {
    let bins = bins.max(1);
    let n = (surface.w as usize) * (surface.h as usize);
    let mut out = Histogram {
        bins,
        r: vec![0; bins as usize],
        g: vec![0; bins as usize],
        b: vec![0; bins as usize],
        luma: vec![0; bins as usize],
    };
    for px in 0..n {
        let i = px * 4;
        let r = sane01(surface.data[i]);
        let g = sane01(surface.data[i + 1]);
        let b = sane01(surface.data[i + 2]);
        out.r[bucket(r, bins)] += 1;
        out.g[bucket(g, bins)] += 1;
        out.b[bucket(b, bins)] += 1;
        let y = LUMA64[0] * r + LUMA64[1] * g + LUMA64[2] * b;
        out.luma[bucket(y, bins)] += 1;
    }
    out
}

/// Waveform of the encoded signal over a `cols × rows` grid (both floored
/// at 1). Image column `x` maps to scope column `x * cols / w`.
pub fn waveform(surface: &GradeSurface, cols: u32, rows: u32) -> Waveform {
    let cols = cols.max(1);
    let rows = rows.max(1);
    let cells = (cols as usize) * (rows as usize);
    let mut out = Waveform {
        cols,
        rows,
        r: vec![0; cells],
        g: vec![0; cells],
        b: vec![0; cells],
    };
    let w = surface.w as usize;
    let h = surface.h as usize;
    if w == 0 {
        return out;
    }
    for py in 0..h {
        for px in 0..w {
            let col = px * cols as usize / w;
            let i = (py * w + px) * 4;
            for (c, plane) in [&mut out.r, &mut out.g, &mut out.b].into_iter().enumerate() {
                let row = bucket(sane01(surface.data[i + c]), rows);
                plane[row * cols as usize + col] += 1;
            }
        }
    }
    out
}

/// Vectorscope of the encoded signal over a `size × size` chroma grid
/// (`size` floored at 1).
pub fn vectorscope(surface: &GradeSurface, size: u32) -> Vectorscope {
    let size = size.max(1);
    let n = (surface.w as usize) * (surface.h as usize);
    let mut out = Vectorscope {
        size,
        counts: vec![0; (size as usize) * (size as usize)],
    };
    for px in 0..n {
        let i = px * 4;
        let r = sane01(surface.data[i]);
        let g = sane01(surface.data[i + 1]);
        let b = sane01(surface.data[i + 2]);
        let y = LUMA64[0] * r + LUMA64[1] * g + LUMA64[2] * b;
        let cb = (b - y) / 1.8556;
        let cr = (r - y) / 1.5748;
        let ix = bucket(cb + 0.5, size);
        let iy = bucket(cr + 0.5, size);
        out.counts[iy * size as usize + ix] += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::surface::GradeSpace;

    fn surf(w: u32, h: u32, data: Vec<f32>) -> GradeSurface {
        GradeSurface {
            w,
            h,
            data,
            space: GradeSpace::Srgb,
        }
    }

    #[test]
    fn histogram_counts_every_pixel_and_puts_one_in_the_last_bin() {
        let s = surf(2, 1, vec![0.0, 0.5, 1.0, 1.0, 1.0, 0.5, 0.0, 1.0]);
        let h = histogram(&s, 4);
        assert_eq!(h.r, vec![1, 0, 0, 1]);
        assert_eq!(h.g, vec![0, 0, 2, 0]);
        assert_eq!(h.b, vec![1, 0, 0, 1]);
        assert_eq!(h.r.iter().sum::<u32>(), 2);
    }

    #[test]
    fn waveform_maps_columns_proportionally() {
        // 4-wide image into 2 scope columns: x 0..1 → col 0, x 2..3 → col 1.
        let mut data = Vec::new();
        for x in 0..4 {
            data.extend([x as f32 / 3.0, 0.0, 0.0, 1.0]);
        }
        let wf = waveform(&surf(4, 1, data), 2, 2);
        // Values 0, 1/3 → rows 0; 2/3, 1 → row 1.
        assert_eq!(wf.r, vec![2, 0, 0, 2]);
    }

    #[test]
    fn vectorscope_puts_neutral_gray_in_the_centre_cell() {
        let s = surf(1, 1, vec![0.5, 0.5, 0.5, 1.0]);
        let v = vectorscope(&s, 9);
        assert_eq!(v.counts[4 * 9 + 4], 1);
        assert_eq!(v.counts.iter().sum::<u32>(), 1);
    }

    #[test]
    fn degenerate_sizes_floor_at_one_and_empty_surfaces_count_nothing() {
        let empty = surf(0, 0, vec![]);
        assert_eq!(histogram(&empty, 0).bins, 1);
        assert_eq!(waveform(&empty, 0, 0).r, vec![0]);
        assert_eq!(vectorscope(&empty, 0).counts, vec![0]);
    }
}
