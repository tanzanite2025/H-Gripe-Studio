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

import type { GradeDoc, GradeLayer, GradeOp } from "./gradeKernel";
import { adjustmentToGradeOps } from "./imageAdjustments";
import type { ImageDocument, ImageLayer } from "./imageDocument";

// Photographic negative: a 256-sample identity-flip LUT (y = 1 - x).
function invertOp(): GradeOp {
  const size = 256;
  const table: number[] = new Array(size * 3);
  for (let i = 0; i < size; i++) {
    const y = 1 - i / (size - 1);
    table[i * 3] = y;
    table[i * 3 + 1] = y;
    table[i * 3 + 2] = y;
  }
  return { type: "lut1d", size, table };
}

// A pixel layer's enabled `invert` steps grade the composite as a negative
// (an odd count flips, an even count cancels out).
function pixelInvertLayer(l: ImageLayer): GradeLayer | null {
  if (l.layer.kind !== "pixel" || !l.visible) return null;
  const count = l.layer.edits.filter((op) => op.type === "invert" && !op.disabled).length;
  if (count % 2 === 0) return null;
  return { blend: "normal", opacity: 1, visible: true, mask: null, ops: [invertOp()] };
}

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
      const inv = pixelInvertLayer(l);
      if (inv) layers.push(inv);
      continue;
    }
    const g = toGradeLayer(l);
    if (g) layers.push(g);
  }
  return { layers };
}
