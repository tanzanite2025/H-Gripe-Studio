// ImageDocument → GradeDoc compilation (image-kernel K2,
// docs/design/image-kernel.md §4).
//
// The image editor does not get a third pixel core: its adjustment stack
// compiles down to the grade kernel's `GradeDoc` and renders through
// `applyDoc` (TS mirror) / `hgripe-grade` (Rust). Pixel-layer compositing
// stays on the mask executor until raster ops move over (K4), so what
// compiles today is the adjustment stack sitting above the pixel
// composite.
//
// `GradeDoc` semantics match the mask editor's adjustment layers: a layer
// grades a copy of the accumulated composite and composites it back per
// blend + opacity, so an adjustment layer at opacity `o` is a grade layer
// with `blend:"normal", opacity:o` (the same lerp `apply_adjustment`
// performs on the u8 side). `imageCompile.test.ts` pins this equivalence.

import type { GradeDoc, GradeLayer } from "./gradeKernel";
import { adjustmentToGradeOps } from "./imageAdjustments";
import type { ImageDocument, ImageLayer } from "./imageDocument";

function toGradeLayer(l: ImageLayer): GradeLayer | null {
  if (l.layer.kind !== "adjustment") return null;
  const ops = l.layer.ops ?? (l.layer.adjustment ? adjustmentToGradeOps(l.layer.adjustment) : []);
  return {
    blend: l.blend,
    opacity: l.opacity,
    visible: l.visible,
    mask: null,
    ops,
  };
}

/**
 * Compile the document's adjustment stack to a grade document, or `null`
 * when the stack is not yet expressible on the grade kernel:
 *
 * - a visible adjustment sitting *below* a visible pixel layer or group
 *   (it grades a partial composite the grade pass never sees), or
 * - a group or layer mask / clipping mask anywhere (K3+).
 *
 * A `null` keeps the caller on the mask executor for the whole render.
 */
export function compileImageAdjustments(doc: ImageDocument): GradeDoc | null {
  const layers: GradeLayer[] = [];
  for (const l of doc.layers) {
    if (l.layer.kind === "group") return null;
    if (l.mask || l.clipped) return null;
    if (l.layer.kind === "pixel") {
      // Pixel content must sit entirely below the graded stack.
      if (l.visible && layers.some((g) => g.visible)) return null;
      continue;
    }
    const g = toGradeLayer(l);
    if (g) layers.push(g);
  }
  return { layers };
}
