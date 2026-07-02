// The serialisable op graph: layers of grading ops replayed in order —
// the same plain-data, everything-revisable document model as the mask
// editor. `apply` is stateless and frame-agnostic (keyframing is the
// caller's job; see docs/design/grade-kernel.md).

use serde::{Deserialize, Serialize};

use crate::blend::BlendMode;
use crate::composite::composite_over;
use crate::ops::{apply_op, GradeOp};
use crate::qualifier::HslQualifier;
use crate::surface::GradeSurface;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GradeDoc {
    pub layers: Vec<GradeLayer>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GradeLayer {
    pub blend: BlendMode,
    pub opacity: f32,
    pub visible: bool,
    /// Optional grayscale gate (`w * h` f32s, `0..=1`) confining the layer's
    /// effect to part of the frame.
    pub mask: Option<Vec<f32>>,
    /// Optional HSL qualifier: a per-pixel gate computed from the layer's
    /// input (the accumulated result below), multiplied with `mask` — the
    /// secondary-grading model. Absent in older documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualifier: Option<HslQualifier>,
    /// The layer's ops, applied in order to a copy of the accumulated result
    /// below; the graded copy then composites back per blend + opacity + mask.
    pub ops: Vec<GradeOp>,
}

/// Run the whole document over `surface` in place. Each visible layer grades
/// a copy of the accumulated result and composites it back — so `normal` at
/// opacity 1 with no mask is simply "apply the ops", while blend/opacity/mask
/// scale the correction like an adjustment layer in PS.
pub fn apply(doc: &GradeDoc, surface: &mut GradeSurface) {
    for layer in &doc.layers {
        if !layer.visible {
            continue;
        }
        apply_layer(layer, surface);
    }
}

// One layer: grade a copy of the accumulated result, gate by
// qualifier × mask, composite back.
fn apply_layer(layer: &GradeLayer, surface: &mut GradeSurface) {
    let gate = layer.qualifier.as_ref().map(|q| {
        let mut g = q.gate(surface);
        if let Some(m) = layer.mask.as_deref() {
            for (gv, mv) in g.iter_mut().zip(m) {
                *gv *= mv.clamp(0.0, 1.0);
            }
        }
        g
    });
    let mask = gate.as_deref().or(layer.mask.as_deref());
    let mut graded = surface.clone();
    for op in &layer.ops {
        apply_op(&mut graded, op);
    }
    composite_over(surface, &graded, layer.blend, layer.opacity, mask);
}

/// Row-parallel [`apply`]: the surface is split into horizontal bands, each
/// band runs the whole document independently (every op and the compositing
/// formula are per-pixel, so this is bit-identical to the serial path —
/// asserted in `tests/parallel.rs`). Only compiled with the `parallel`
/// feature, per the design doc's dependency policy.
#[cfg(feature = "parallel")]
pub fn apply_parallel(doc: &GradeDoc, surface: &mut GradeSurface) {
    use rayon::prelude::*;

    let w = surface.w as usize;
    let h = surface.h as usize;
    if w == 0 || h == 0 {
        return;
    }
    let rows_per_band = h.div_ceil(rayon::current_num_threads()).max(1);
    let space = surface.space;
    surface
        .data
        .par_chunks_mut(rows_per_band * w * 4)
        .enumerate()
        .for_each(|(band, chunk)| {
            let rows = chunk.len() / (w * 4);
            let start_px = band * rows_per_band * w;
            let mut band_surface = GradeSurface {
                w: w as u32,
                h: rows as u32,
                data: chunk.to_vec(),
                space,
            };
            for layer in &doc.layers {
                if !layer.visible {
                    continue;
                }
                let band_layer = GradeLayer {
                    mask: layer
                        .mask
                        .as_deref()
                        .map(|m| m[start_px..start_px + rows * w].to_vec()),
                    ..layer.clone()
                };
                apply_layer(&band_layer, &mut band_surface);
            }
            chunk.copy_from_slice(&band_surface.data);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::surface::GradeSpace;

    #[test]
    fn hidden_layers_are_skipped_and_docs_round_trip_serde() {
        let doc = GradeDoc {
            layers: vec![GradeLayer {
                blend: BlendMode::Normal,
                opacity: 1.0,
                visible: false,
                mask: None,
                qualifier: None,
                ops: vec![GradeOp::Exposure { ev: 2.0 }],
            }],
        };
        let mut s = GradeSurface {
            w: 1,
            h: 1,
            data: vec![0.5, 0.5, 0.5, 1.0],
            space: GradeSpace::Srgb,
        };
        let before = s.data.clone();
        apply(&doc, &mut s);
        assert_eq!(s.data, before);

        let json = serde_json::to_string(&doc).expect("serialise");
        assert_eq!(serde_json::from_str::<GradeDoc>(&json).expect("parse"), doc);
    }
}
