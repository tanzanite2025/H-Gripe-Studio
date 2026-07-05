// Op registry (image-kernel K0, docs/design/image-kernel.md §3).
//
// Every editing action in the studio is recorded as an Op — plain revisable
// data replayed in order. This table is the single place ops are *declared*:
// which kernel executes an op, and what role it plays in a document. It does
// not change behaviour (K0); later milestones key panels, i18n, and the
// ImageDocument compiler off these rows.
//
// Exhaustiveness is enforced by the type system where the op union is a
// closed type (`GradeOp`, `AdjustmentType`) — adding an op without a registry
// row fails `tsc`. Mask op kinds are an open `string` on `MaskOperation`, so
// they are pinned by the const list below plus the registry unit test.

import type { AdjustmentType, EditOp } from "../types/production";
import type { GradeOp } from "./gradeKernel";

/** Which execution core replays an op (image-kernel.md §1). */
export type OpKernel =
  /** u8 grayscale mask compositor (`subject_mask.rs` + `maskMorphology.ts`). */
  | "mask"
  /** f32 colour core (`crates/hgripe-grade` + `gradeKernel/` mirror). */
  | "grade"
  /** Pixel-layer raster ops (image editor only; lands at K4). */
  | "raster";

export interface OpMeta {
  kernel: OpKernel;
  /**
   * Whether the op is a parameter-only adjustment (usable as an adjustment
   * layer in both the image editor and the grade dialog) as opposed to a
   * stroke / geometry edit recorded on a specific layer.
   */
  adjustment: boolean;
}

// ---------------------------------------------------------------------------
// Mask kernel ops — today's `EditPaths.ops` vocabulary. `MaskOperation.type`
// is an open string in the wire format; this list is the closed set the
// studio actually records (see the doc comment on `MaskOperation`).
// ---------------------------------------------------------------------------

export const MASK_OP_TYPES = [
  "path",
  "brush",
  "wand",
  "invert",
  "fill_holes",
  "smooth",
  "grow",
  "shrink",
  "feather",
  "rect",
  "ellipse",
  "crop",
  "transform",
  "select_all",
  "delete",
  "gradient",
  "fill",
  "heal",
  "clone",
  "history_brush",
  "dodge_burn",
  "sponge",
  "healing_brush",
  "quick_select",
  "background_eraser",
  "patch",
  "perspective_crop",
  "red_eye",
  "object_select",
  "remove",
  "content_aware_move",
  "pattern_stamp",
  "art_history_brush",
] as const;
export type MaskOpType = (typeof MASK_OP_TYPES)[number];

const MASK_OP_META: OpMeta = { kernel: "mask", adjustment: false };

export const MASK_OPS: Record<MaskOpType, OpMeta> = Object.fromEntries(
  MASK_OP_TYPES.map((type) => [type, MASK_OP_META]),
) as Record<MaskOpType, OpMeta>;

// ---------------------------------------------------------------------------
// Mask-document adjustment layers (M6). These execute in the u8 mask kernel
// today; at image-kernel K2 the image workspace re-targets them onto the
// grade kernel's f32 ops (levels → levels, curve → curves, …).
// ---------------------------------------------------------------------------

export const MASK_ADJUSTMENTS: Record<AdjustmentType, OpMeta> = {
  levels: { kernel: "mask", adjustment: true },
  curve: { kernel: "mask", adjustment: true },
  brightness_contrast: { kernel: "mask", adjustment: true },
};

// ---------------------------------------------------------------------------
// Grade kernel ops — the shared f32 vocabulary. Declared once, consumed by
// both the image editor's adjustment layers (K2+) and the video grade
// dialog. Exhaustive over `GradeOp["type"]` by construction.
// ---------------------------------------------------------------------------

const GRADE_ADJ: OpMeta = { kernel: "grade", adjustment: true };

export const GRADE_OPS: Record<GradeOp["type"], OpMeta> = {
  exposure: GRADE_ADJ,
  white_balance: GRADE_ADJ,
  white_balance_k: GRADE_ADJ,
  levels: GRADE_ADJ,
  curves: GRADE_ADJ,
  saturation: GRADE_ADJ,
  lift_gamma_gain: GRADE_ADJ,
  hsl_adjust: GRADE_ADJ,
  lut3d: GRADE_ADJ,
  lut1d: GRADE_ADJ,
  hue_vs_hue: GRADE_ADJ,
  hue_vs_sat: GRADE_ADJ,
  lum_vs_sat: GRADE_ADJ,
  sat_vs_sat: GRADE_ADJ,
  log_wheels: GRADE_ADJ,
  contrast: GRADE_ADJ,
  soft_clip: GRADE_ADJ,
  rgb_mixer: GRADE_ADJ,
  color_warper: GRADE_ADJ,
  sharpen: GRADE_ADJ,
  denoise: GRADE_ADJ,
  film_grain: GRADE_ADJ,
  blur: GRADE_ADJ,
  vignette: GRADE_ADJ,
};

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Registry row for a recorded mask-document edit op, if declared. */
export function maskOpMeta(op: EditOp): OpMeta | null {
  return (MASK_OPS as Record<string, OpMeta>)[op.type] ?? null;
}

/** Registry row for a grade op (always declared — the union is closed). */
export function gradeOpMeta(op: GradeOp): OpMeta {
  return GRADE_OPS[op.type];
}
