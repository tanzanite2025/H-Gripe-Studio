// The serialisable op graph: layers of grading ops replayed in order —
// the same plain-data, everything-revisable document model as the mask
// editor. `apply` is stateless and frame-agnostic (keyframing is the
// caller's job; see docs/design/grade-kernel.md).

use serde::{Deserialize, Serialize};

use crate::blend::BlendMode;
use crate::composite::composite_over;
use crate::ops::{apply_op, GradeOp};
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
        let mut graded = surface.clone();
        for op in &layer.ops {
            apply_op(&mut graded, op);
        }
        composite_over(surface, &graded, layer.blend, layer.opacity, layer.mask.as_deref());
    }
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
