// LUT sampling (1D linear, 3D tetrahedral) and the `.cube` parser.

use super::GradeOp;

/// A 1D LUT view over a `.cube` `LUT_1D_SIZE` table (`size` RGB triples),
/// sampled per channel with linear interpolation.
pub(super) struct Lut1d<'a> {
    size: usize,
    table: &'a [f32],
}

impl<'a> Lut1d<'a> {
    pub(super) fn new(size: u32, table: &'a [f32]) -> Self {
        let size = size as usize;
        assert!(size >= 2, "LUT size must be at least 2");
        assert_eq!(table.len(), size * 3, "LUT table length");
        Self { size, table }
    }

    pub(super) fn sample(&self, channel: usize, v: f32) -> f32 {
        let pos = v * (self.size - 1) as f32;
        let i0 = (pos as usize).min(self.size - 2);
        let f = pos - i0 as f32;
        let a = self.table[i0 * 3 + channel];
        let b = self.table[(i0 + 1) * 3 + channel];
        a + (b - a) * f
    }
}

/// A 3D LUT view over a `.cube`-layout table (red varies fastest), sampled
/// with trilinear interpolation.
pub(super) struct Lut3d<'a> {
    size: usize,
    table: &'a [f32],
}

impl<'a> Lut3d<'a> {
    pub(super) fn new(size: u32, table: &'a [f32]) -> Self {
        let size = size as usize;
        assert!(size >= 2, "LUT size must be at least 2");
        assert_eq!(table.len(), size * size * size * 3, "LUT table length");
        Self { size, table }
    }

    fn entry(&self, r: usize, g: usize, b: usize) -> [f32; 3] {
        let i = ((b * self.size + g) * self.size + r) * 3;
        [self.table[i], self.table[i + 1], self.table[i + 2]]
    }

    // Tetrahedral interpolation — the design doc's single LUT-sampling
    // definition (same choice as the ICC engine): pick one of six
    // tetrahedra by the ordering of the fractional offsets, blend its
    // four vertices.
    pub(super) fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = (self.size - 1) as f32;
        let pos = [rgb[0] * n, rgb[1] * n, rgb[2] * n];
        let i0 = [
            (pos[0] as usize).min(self.size - 2),
            (pos[1] as usize).min(self.size - 2),
            (pos[2] as usize).min(self.size - 2),
        ];
        let f = [
            pos[0] - i0[0] as f32,
            pos[1] - i0[1] as f32,
            pos[2] - i0[2] as f32,
        ];
        let v = |dr: usize, dg: usize, db: usize| self.entry(i0[0] + dr, i0[1] + dg, i0[2] + db);
        let (fr, fg, fb) = (f[0], f[1], f[2]);
        // (w1, vertex1), (w2, vertex2), (w3, vertex3) between c000 and c111.
        let (w1, e1, w2, e2, w3, e3) = if fr > fg {
            if fg > fb {
                (fr, v(1, 0, 0), fg, v(1, 1, 0), fb, v(1, 1, 1))
            } else if fr > fb {
                (fr, v(1, 0, 0), fb, v(1, 0, 1), fg, v(1, 1, 1))
            } else {
                (fb, v(0, 0, 1), fr, v(1, 0, 1), fg, v(1, 1, 1))
            }
        } else if fb > fg {
            (fb, v(0, 0, 1), fg, v(0, 1, 1), fr, v(1, 1, 1))
        } else if fb > fr {
            (fg, v(0, 1, 0), fb, v(0, 1, 1), fr, v(1, 1, 1))
        } else {
            (fg, v(0, 1, 0), fr, v(1, 1, 0), fb, v(1, 1, 1))
        };
        let e0 = v(0, 0, 0);
        let mut out = [0.0f32; 3];
        for c in 0..3 {
            out[c] = e0[c] + w1 * (e1[c] - e0[c]) + w2 * (e2[c] - e1[c]) + w3 * (e3[c] - e2[c]);
        }
        out
    }
}

/// Parse a `.cube` LUT (Adobe/Resolve format) into a [`GradeOp::Lut3d`]
/// (`LUT_3D_SIZE`) or [`GradeOp::Lut1d`] (`LUT_1D_SIZE`). Supports `TITLE`,
/// `DOMAIN_MIN`/`DOMAIN_MAX` (only the standard `0 0 0` / `1 1 1` domain is
/// accepted), comments, and blank lines. Written in-crate per the design
/// doc's dependency policy.
pub fn parse_cube(text: &str) -> Result<GradeOp, String> {
    let mut size: Option<u32> = None;
    let mut size_1d: Option<u32> = None;
    let mut table: Vec<f32> = Vec::new();
    for (lineno, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let head = parts.next().expect("non-empty line");
        match head {
            "TITLE" => {}
            "LUT_3D_SIZE" => {
                let v: u32 = parts
                    .next()
                    .ok_or_else(|| format!("line {}: LUT_3D_SIZE missing value", lineno + 1))?
                    .parse()
                    .map_err(|e| format!("line {}: bad LUT_3D_SIZE: {e}", lineno + 1))?;
                if v < 2 {
                    return Err(format!("line {}: LUT_3D_SIZE must be >= 2", lineno + 1));
                }
                size = Some(v);
            }
            "DOMAIN_MIN" | "DOMAIN_MAX" => {
                let want = if head == "DOMAIN_MIN" { 0.0 } else { 1.0 };
                for _ in 0..3 {
                    let v: f32 = parts
                        .next()
                        .ok_or_else(|| format!("line {}: {head} missing values", lineno + 1))?
                        .parse()
                        .map_err(|e| format!("line {}: bad {head}: {e}", lineno + 1))?;
                    if v != want {
                        return Err(format!(
                            "line {}: only the standard 0..1 domain is supported",
                            lineno + 1
                        ));
                    }
                }
            }
            "LUT_1D_SIZE" => {
                let v: u32 = parts
                    .next()
                    .ok_or_else(|| format!("line {}: LUT_1D_SIZE missing value", lineno + 1))?
                    .parse()
                    .map_err(|e| format!("line {}: bad LUT_1D_SIZE: {e}", lineno + 1))?;
                if v < 2 {
                    return Err(format!("line {}: LUT_1D_SIZE must be >= 2", lineno + 1));
                }
                size_1d = Some(v);
            }
            _ => {
                // A data row: three floats (red varies fastest).
                let mut row = [0.0f32; 3];
                row[0] = head
                    .parse()
                    .map_err(|e| format!("line {}: bad value: {e}", lineno + 1))?;
                for slot in row.iter_mut().skip(1) {
                    *slot = parts
                        .next()
                        .ok_or_else(|| format!("line {}: expected 3 values", lineno + 1))?
                        .parse()
                        .map_err(|e| format!("line {}: bad value: {e}", lineno + 1))?;
                }
                table.extend_from_slice(&row);
            }
        }
    }
    match (size, size_1d) {
        (Some(_), Some(_)) => Err(
            "both LUT_3D_SIZE and LUT_1D_SIZE present; split the shaper into its own file".into(),
        ),
        (Some(size), None) => {
            let expect = (size as usize).pow(3) * 3;
            if table.len() != expect {
                return Err(format!(
                    "expected {expect} table values, got {}",
                    table.len()
                ));
            }
            Ok(GradeOp::Lut3d { size, table })
        }
        (None, Some(size)) => {
            let expect = size as usize * 3;
            if table.len() != expect {
                return Err(format!(
                    "expected {expect} table values, got {}",
                    table.len()
                ));
            }
            Ok(GradeOp::Lut1d { size, table })
        }
        (None, None) => Err("missing LUT_3D_SIZE or LUT_1D_SIZE".into()),
    }
}
