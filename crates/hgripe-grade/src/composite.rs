// The layer compositing primitive: blend a source surface over a backdrop
// per W3C compositing-1 simple alpha compositing with a blend mode.
//
// Straight-alpha form, per channel:
//   αs' = αs × opacity × mask          (the source's effective alpha)
//   αo  = αs' + αb × (1 − αs')
//   Co  = ( αs'×(1−αb)×Cs + αs'×αb×B(Cb,Cs) + (1−αs')×αb×Cb ) / αo
// (Co = 0 where αo = 0.) No quantisation — everything stays f32.

use crate::blend::{blend_rgb, BlendMode};
use crate::surface::GradeSurface;

/// Composite `src` over `dst` in place. `opacity` is the layer opacity
/// (`0..=1`); `mask`, when present, is a per-pixel grayscale gate
/// (`w * h` f32s, `0..=1`) scaling the source alpha — the layer-mask model
/// from the design doc. Surfaces must share dimensions and space.
pub fn composite_over(dst: &mut GradeSurface, src: &GradeSurface, mode: BlendMode, opacity: f32, mask: Option<&[f32]>) {
    assert_eq!((dst.w, dst.h), (src.w, src.h), "surface dimensions");
    assert_eq!(dst.space, src.space, "surface space");
    if let Some(m) = mask {
        assert_eq!(m.len(), (dst.w as usize) * (dst.h as usize), "mask length");
    }
    let opacity = opacity.clamp(0.0, 1.0);

    for px in 0..(dst.w as usize) * (dst.h as usize) {
        let i = px * 4;
        let gate = mask.map_or(1.0, |m| m[px].clamp(0.0, 1.0));
        let sa = src.data[i + 3].clamp(0.0, 1.0) * opacity * gate;
        let ba = dst.data[i + 3].clamp(0.0, 1.0);
        let oa = sa + ba * (1.0 - sa);
        let cb = [
            dst.data[i].clamp(0.0, 1.0),
            dst.data[i + 1].clamp(0.0, 1.0),
            dst.data[i + 2].clamp(0.0, 1.0),
        ];
        let cs = [
            src.data[i].clamp(0.0, 1.0),
            src.data[i + 1].clamp(0.0, 1.0),
            src.data[i + 2].clamp(0.0, 1.0),
        ];
        let blended = blend_rgb(mode, cb, cs);
        for c in 0..3 {
            dst.data[i + c] = if oa == 0.0 {
                0.0
            } else {
                let mixed = sa * (1.0 - ba) * cs[c] + sa * ba * blended[c] + (1.0 - sa) * ba * cb[c];
                mixed / oa
            };
        }
        dst.data[i + 3] = oa;
    }
}
