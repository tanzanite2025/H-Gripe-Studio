// Planckian-locus white balance maths (the `white_balance_k` op).

use super::LUMA;

/// Rec.709 linear RGB channel gains for a Planckian white point at
/// `temp_k` (+ `tint` Δy), relative to the 6504 K neutral, luma-normalised.
/// CCT → xy uses the Kim et al. cubic approximation of the Planckian locus
/// (the standard CIE fit, valid 1667..25000 K); xy → XYZ → Rec.709 uses the
/// IEC/ITU matrix. All in f64 so both ends agree within f32 tolerance.
pub(crate) fn planckian_gains(temp_k: f32, tint: f32) -> [f32; 3] {
    let reference = planckian_rgb(6504.0, 0.0);
    let target = planckian_rgb(f64::from(temp_k), f64::from(tint));
    let raw = [
        target[0] / reference[0],
        target[1] / reference[1],
        target[2] / reference[2],
    ];
    let luma =
        f64::from(LUMA[0]) * raw[0] + f64::from(LUMA[1]) * raw[1] + f64::from(LUMA[2]) * raw[2];
    [
        (raw[0] / luma) as f32,
        (raw[1] / luma) as f32,
        (raw[2] / luma) as f32,
    ]
}

fn planckian_rgb(temp_k: f64, tint: f64) -> [f64; 3] {
    let t = if temp_k.is_finite() {
        temp_k.clamp(1667.0, 25000.0)
    } else {
        6504.0
    };
    // Kim et al. cubic fit of the Planckian locus.
    let x = if t <= 4000.0 {
        -0.2661239e9 / (t * t * t) - 0.2343589e6 / (t * t) + 0.8776956e3 / t + 0.179910
    } else {
        -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.240390
    };
    let y_locus = if t <= 2222.0 {
        ((-1.1063814 * x - 1.34811020) * x + 2.18555832) * x - 0.20219683
    } else if t <= 4000.0 {
        ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867
    } else {
        ((3.0817580 * x - 5.87338670) * x + 3.75112997) * x - 0.37001483
    };
    let tint = if tint.is_finite() {
        tint.clamp(-1.0, 1.0)
    } else {
        0.0
    };
    let y = (y_locus + 0.05 * tint).max(1e-4);
    // xyY (Y = 1) → XYZ → linear Rec.709.
    let big_x = x / y;
    let big_z = (1.0 - x - y) / y;
    let r = 3.2404542 * big_x - 1.5371385 - 0.4985314 * big_z;
    let g = -0.9692660 * big_x + 1.8760108 + 0.0415560 * big_z;
    let b = 0.0556434 * big_x - 0.2040259 + 1.0572252 * big_z;
    [r.max(1e-4), g.max(1e-4), b.max(1e-4)]
}
