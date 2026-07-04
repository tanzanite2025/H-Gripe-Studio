// Bake a grade document to a `.cube` 3D LUT: sample the identity lattice
// through the document and serialise the graded lattice in the Adobe/Resolve
// `.cube` layout (red varies fastest). A LUT is a pure colour→colour map, so
// spatial ops ([`GradeOp::is_spatial`]) and positional layer masks are
// excluded by construction — they read neighbouring pixels or frame
// positions and cannot be represented; colour-keyed qualifiers *are* baked.

use crate::doc::{apply, GradeDoc};
use crate::ops::GradeOp;
use crate::surface::{GradeSpace, GradeSurface};

/// Largest `.cube` lattice the baker will emit (Resolve's common maximum).
pub const MAX_CUBE_SIZE: u32 = 129;

/// The result of [`bake_cube`]: the `.cube` text plus what the bake had to
/// leave out to stay a pure colour map.
#[derive(Debug, Clone, PartialEq)]
pub struct CubeBake {
    /// The `.cube` file contents ([`crate::parse_cube`] round-trips it).
    pub cube: String,
    /// Spatial ops ([`GradeOp::is_spatial`]) dropped from the bake.
    pub skipped_spatial_ops: usize,
    /// Positional layer masks dropped from the bake (the layer still bakes,
    /// applied everywhere).
    pub dropped_masks: usize,
}

/// Bake `doc` to a `.cube` 3D LUT of `size` (per axis, `2..=`[`MAX_CUBE_SIZE`])
/// by grading the identity lattice in `space` through the CPU reference path.
/// Spatial ops and positional layer masks are excluded (counted on the
/// result); everything else — including HSL qualifiers, which gate on colour
/// only — bakes exactly.
pub fn bake_cube(doc: &GradeDoc, size: u32, space: GradeSpace) -> Result<CubeBake, String> {
    if !(2..=MAX_CUBE_SIZE).contains(&size) {
        return Err(format!(
            "cube size must be between 2 and {MAX_CUBE_SIZE}, got {size}"
        ));
    }

    let mut skipped_spatial_ops = 0usize;
    let mut dropped_masks = 0usize;
    let layers = doc
        .layers
        .iter()
        .map(|layer| {
            let mut layer = layer.clone();
            if layer.mask.take().is_some() && layer.visible {
                dropped_masks += 1;
            }
            let before = layer.ops.len();
            layer.ops.retain(|op: &GradeOp| !op.is_spatial());
            if layer.visible {
                skipped_spatial_ops += before - layer.ops.len();
            }
            layer
        })
        .collect();
    let baked_doc = GradeDoc { layers };

    // The identity lattice as a surface: one pixel per lattice point in the
    // `.cube` order (red varies fastest, then green, then blue). Every
    // remaining op is pixel-local, so the surface shape is immaterial.
    let n = size as usize;
    let count = n * n * n;
    let step = 1.0 / (size - 1) as f32;
    let mut data = Vec::with_capacity(count * 4);
    for i in 0..count {
        data.push((i % n) as f32 * step);
        data.push(((i / n) % n) as f32 * step);
        data.push((i / (n * n)) as f32 * step);
        data.push(1.0);
    }
    let mut surface = GradeSurface {
        w: size,
        h: size * size,
        data,
        space,
    };
    apply(&baked_doc, &mut surface);

    let mut cube = String::with_capacity(count * 30 + 64);
    cube.push_str("# baked by hgripe-grade\n");
    cube.push_str(&format!("LUT_3D_SIZE {size}\n"));
    for i in 0..count {
        let px = i * 4;
        let r = surface.data[px].clamp(0.0, 1.0);
        let g = surface.data[px + 1].clamp(0.0, 1.0);
        let b = surface.data[px + 2].clamp(0.0, 1.0);
        cube.push_str(&format!("{r:.6} {g:.6} {b:.6}\n"));
    }

    Ok(CubeBake {
        cube,
        skipped_spatial_ops,
        dropped_masks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blend::BlendMode;
    use crate::doc::GradeLayer;
    use crate::ops::parse_cube;

    fn layer(ops: Vec<GradeOp>) -> GradeLayer {
        GradeLayer {
            blend: BlendMode::Normal,
            opacity: 1.0,
            visible: true,
            mask: None,
            qualifier: None,
            ops,
        }
    }

    #[test]
    fn identity_doc_bakes_the_identity_lattice() {
        let doc = GradeDoc { layers: vec![] };
        let baked = bake_cube(&doc, 3, GradeSpace::Srgb).expect("bake");
        assert_eq!(baked.skipped_spatial_ops, 0);
        assert_eq!(baked.dropped_masks, 0);
        let op = parse_cube(&baked.cube).expect("round trip");
        match op {
            GradeOp::Lut3d { size, table } => {
                assert_eq!(size, 3);
                // First entry is black, last is white, red varies fastest.
                assert_eq!(&table[..3], &[0.0, 0.0, 0.0]);
                assert_eq!(&table[3..6], &[0.5, 0.0, 0.0]);
                assert_eq!(&table[table.len() - 3..], &[1.0, 1.0, 1.0]);
            }
            other => panic!("expected a 3D LUT, got {other:?}"),
        }
    }

    #[test]
    fn baked_lut_matches_the_direct_grade_on_lattice_points() {
        let doc = GradeDoc {
            layers: vec![layer(vec![
                GradeOp::Exposure { ev: 0.5 },
                GradeOp::Saturation { amount: -0.3 },
            ])],
        };
        let baked = bake_cube(&doc, 17, GradeSpace::Srgb).expect("bake");
        let lut = parse_cube(&baked.cube).expect("parse");

        // Grading a pixel directly and sampling it through the baked LUT
        // agree on lattice points (both are exact there).
        let mut direct = GradeSurface {
            w: 1,
            h: 1,
            data: vec![0.25, 0.5, 0.75, 1.0],
            space: GradeSpace::Srgb,
        };
        apply(&doc, &mut direct);
        let mut sampled = GradeSurface {
            w: 1,
            h: 1,
            data: vec![0.25, 0.5, 0.75, 1.0],
            space: GradeSpace::Srgb,
        };
        crate::ops::apply_op(&mut sampled, &lut);
        for c in 0..3 {
            assert!(
                (direct.data[c] - sampled.data[c]).abs() < 1e-4,
                "channel {c}: direct {} vs sampled {}",
                direct.data[c],
                sampled.data[c]
            );
        }
    }

    #[test]
    fn spatial_ops_and_masks_are_excluded_and_counted() {
        let mut masked = layer(vec![GradeOp::Exposure { ev: 1.0 }]);
        masked.mask = Some(vec![1.0]);
        let doc = GradeDoc {
            layers: vec![
                masked,
                layer(vec![
                    GradeOp::Blur { sigma: 4.0 },
                    GradeOp::Vignette {
                        amount: -0.5,
                        midpoint: 0.5,
                        feather: 0.5,
                    },
                    GradeOp::Contrast {
                        amount: 1.2,
                        pivot: 0.5,
                    },
                ]),
            ],
        };
        let baked = bake_cube(&doc, 5, GradeSpace::Srgb).expect("bake");
        assert_eq!(baked.skipped_spatial_ops, 2);
        assert_eq!(baked.dropped_masks, 1);
        // The remaining point ops still bake: the result is not identity.
        let op = parse_cube(&baked.cube).expect("parse");
        match op {
            GradeOp::Lut3d { table, .. } => {
                assert!(table.iter().any(|&v| v != 0.0 && v != 1.0));
            }
            other => panic!("expected a 3D LUT, got {other:?}"),
        }
    }

    #[test]
    fn rejects_out_of_range_sizes() {
        let doc = GradeDoc { layers: vec![] };
        assert!(bake_cube(&doc, 1, GradeSpace::Srgb).is_err());
        assert!(bake_cube(&doc, MAX_CUBE_SIZE + 1, GradeSpace::Srgb).is_err());
    }
}
