// Production data contracts for the PSD-first AI production pipeline.
//
// These interfaces are the TypeScript mirror of the **single source of truth**
// Rust structs in `apps/desktop-tauri/src-tauri/src/contracts.rs`. The same JSON
// object round-trips unchanged across the Python bridge (producer), the Rust
// orchestration layer, and this front end, so field names stay snake_case and
// must be kept in lock-step with the Rust definitions.

/** A rectangle in PSD canvas pixel coordinates. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Background appearance extracted from the template's background layer(s). */
export interface BackgroundContext {
  /** Mean RGB colour, 0-255 per channel. */
  mean_color: [number, number, number];
  /** Dominant palette as `#rrggbb` hex strings, most frequent first. */
  dominant_palette: string[];
  /** Mean luminance, normalised 0.0-1.0. */
  brightness: number;
  /** Luminance spread (heuristic), normalised 0.0-1.0. */
  contrast: number;
  /** Optional path to a written histogram preview PNG. */
  histogram_path: string | null;
  /** Optional path to the composited background preview PNG (a node output). */
  image_path: string | null;
}

/** Lighting heuristics inferred from the background. */
export interface LightingContext {
  /** Dominant light direction, e.g. `top-left` / `center`. */
  direction: string;
  /** `hard` or `soft`, inferred from contrast. */
  quality: string;
  /** Estimated colour temperature in Kelvin. */
  color_temperature: number;
  /** Human-readable summary of the lighting/background. */
  description: string;
}

/** Where the generated subject will be placed inside the template. */
export interface PlaceholderContext {
  /** Resolved placeholder layer name (empty when the whole canvas is used). */
  layer_name: string;
  /** Placeholder rectangle in canvas pixels. */
  bounds: Bounds;
  /** Optional path to a written placeholder mask PNG (a node output). */
  mask_path: string | null;
  /** Optional inset "safe area" inside the bounds. */
  safe_area: Bounds | null;
}

/**
 * Structured visual context produced by the PSD Context Analyze node and
 * consumed by downstream production nodes (Light & Color Match, etc.).
 */
export interface VisualContext {
  background: BackgroundContext;
  lighting: LightingContext;
  placeholder: PlaceholderContext;
  /** Lighting/colour description ready to append to a generation prompt. */
  prompt_suffix: string;
}

/** A single detected quality issue (Detail Watchdog). */
export interface QualityIssue {
  /** e.g. `face_blur | hand_error | edge_halo | color_mismatch | low_resolution`. */
  type: string;
  confidence: number;
  /** `[x1, y1, x2, y2]` in canvas pixels. */
  bbox: [number, number, number, number];
  suggested_action: string;
}

/** Aggregate quality findings for a candidate image. */
export interface QualityReport {
  /** `passed | warning | failed`. */
  status: string;
  issues: QualityIssue[];
}

/** Per-region outcome of a Detail Repaint run (mirrors Rust `RepaintRegionResult`). */
export interface RepaintRegionResult {
  /** Index of the issue in the source QualityReport. */
  index: number;
  /** Issue type carried over from the QualityReport (e.g. `face_blur`). */
  type?: string | null;
  /** `[x1, y1, x2, y2]` issue box in canvas pixels. */
  bbox?: [number, number, number, number] | null;
  /** `repainted | no_repaint | bad_geometry | skipped`. */
  status: string;
  /** Seam feather radius actually used when the region was repainted. */
  feather_px?: number | null;
  /** Seam blend actually applied (`feather` | `poisson`); a `poisson` request
   *  degrades to `feather` on a too-small region. */
  blend?: string | null;
}

/** Outcome of the Detail Repaint node (mirrors Rust `RepaintReport`). */
export interface RepaintReport {
  /** `unchanged | partial | repainted`. */
  status: string;
  regions: RepaintRegionResult[];
  /** How many regions were actually repainted. */
  repainted_count: number;
  /** How many regions the composite step was asked to handle. */
  requested_count: number;
  /** `[width, height]` of the fixed image. */
  image_size: [number, number];
  /** Seam blend mode the composite ran (`feather` | `poisson`). */
  blend?: string;
  // --- Optional local-engine telemetry (Detail Repaint `engine` seam) --------
  // Present only when a non-`provider` engine was selected; carries which
  // engine actually ran and why it fell back, so the UI can explain a
  // provider/passthrough result. Absent for the plain provider path.
  /** Engine that actually ran (`provider` when it fell back). */
  engine?: string;
  /** Engine the node asked for. */
  engine_requested?: string;
  /** Why the local backend was not used (missing deps/weight, etc.). */
  engine_fallback_reason?: string | null;
  /** Resolved local weight identifier, when a local backend ran. */
  backend_model?: string | null;
  /** Compute device the local backend bound (`cpu`/`cuda`); null on provider. */
  device?: string | null;
  /** Compute precision the local backend bound (`fp16`/`fp32`); null on provider. */
  precision?: string | null;
  /** Compute precision the node asked for (`auto`/`fp32`/`fp16`). */
  precision_requested?: string;
  /** Structural conditioning the node asked for (`off`/`canny`). */
  controlnet_requested?: string;
}

/** Exported artifact paths recorded for a finished workflow. */
export interface ExportedArtifacts {
  psd: string;
  preview: string;
  metadata: string;
}

/**
 * A single bezier/lasso path edit (Subject Mask). The backend flattens the
 * anchor loop (cubic bezier where control handles are present), rasterises the
 * closed polygon and boolean-combines it with the mask per `mode`. Mirrors the
 * Rust `EditPaths` schema in `docs/cards/subject-mask-matte.md`.
 */
export interface EditPathPoint {
  x: number;
  y: number;
  /** Bezier in-control handle, when the path is a pen curve. */
  in?: [number, number];
  /** Bezier out-control handle, when the path is a pen curve. */
  out?: [number, number];
}

export interface EditPath {
  id: string;
  /** `add` | `subtract` | `intersect`. */
  mode: string;
  /** `pen` | `lasso` | `shape`. */
  tool: string;
  closed: boolean;
  points: EditPathPoint[];
}

/**
 * A freehand brush/eraser stroke (applied by the Rust backend on run).
 *
 * The optional soft-brush fields (M4) are recorded only when the stroke is
 * soft (`hardness < 1` or `flow < 1`); a stroke without them replays through
 * the legacy hard-edged stamp, byte-identical to the pre-M4 flow.
 */
export interface BrushStroke {
  id: string;
  /** `add` (brush) | `subtract` (eraser). */
  mode: string;
  /** Stroke radius in image pixels. */
  radius: number;
  /** Polyline of `[x, y]` points the stroke passes through. */
  points: [number, number][];
  /** 0..1 — fraction of the radius that is fully opaque; the coverage falls
   *  linearly to 0 at the rim. Absent ⇒ 1 (hard edge). */
  hardness?: number;
  /** 0..1 — caps the stroke's coverage (PS Flow, max-composited). Absent ⇒ 1. */
  flow?: number;
  /** Stamp interval as a fraction of the brush diameter. Absent ⇒ 0.25. */
  spacing?: number;
}

/**
 * A recorded morphology / selection operation queued for the backend to apply
 * (in order) when the node runs. Phase 1 records the *intent* here rather than
 * re-implementing the exact Rust morphology in the webview, so the preview and
 * the executed result cannot drift.
 */
export interface MaskOperation {
  /** `wand` | `invert` | `fill_holes` | `smooth` | `grow` | `shrink` | `feather` | `rect` | `ellipse` | `crop` | `transform` | `select_all` | `delete` | `gradient` | `fill` | `heal` | `clone` | `history_brush` | `dodge_burn` | `sponge` | `healing_brush` | `quick_select` | `background_eraser` | `patch` | `perspective_crop` | `red_eye` | `object_select` | `remove` | `content_aware_move` | `pattern_stamp` | `art_history_brush`. */
  type: string;
  /** Operation-specific scalar (tolerance / px / radius; for `fill`: opacity 0..100; for `heal` / `clone` / `history_brush` / `dodge_burn`: brush radius px), when relevant. */
  amount?: number;
  /** `[x, y]` seed for `wand` / `red_eye`, `[x1, y1, x2, y2]` for marquee / `crop` ops (for `gradient`: the drag vector start → end), or the quad corners `[x0,y0, x1,y1, x2,y2, x3,y3]` (TL, TR, BR, BL) for `perspective_crop`. `object_select`: the `[x1, y1, x2, y2]` box the segmenter is constrained to. */
  region?: number[];
  /** `heal` / `clone` / `history_brush` / `dodge_burn`: the stroke polyline in image px (`patch`: the lassoed polygon). `heal` rebuilds the painted region from its surroundings; `clone` copies the mask from the `dx`/`dy` source offset; `history_brush` restores the region to the layer's initial (pre-edit) state; `dodge_burn` lightens (`mode: "dodge"`) or darkens (`mode: "burn"`) the region. `remove` seeds the segmenter with the stroke points and subtracts the segmented object; `content_aware_move` moves the lassoed polygon by `dx`/`dy` and heals the hole behind it; `pattern_stamp` paints the repeating checker pattern; `art_history_brush` restores the initial state through a deterministic jitter. */
  points?: [number, number][];
  /** `gradient` / `fill`: `add` unions in, `subtract` cuts away (absent ⇒ `add`). `dodge_burn`: `dodge` lightens, `burn` darkens (absent ⇒ `dodge`). `sponge`: `saturate` pushes covered pixels away from mid-grey, `desaturate` toward it (absent ⇒ `saturate`). */
  mode?: string;
  /** `background_eraser`: colour tolerance (0..255) against the sample under the brush centre. */
  tolerance?: number;
  // --- `transform` op params (M5 free transform / move) -----------------
  // A `transform` step moves the mask by `dx`/`dy` px and scales / rotates
  // it about the canvas centre. Absent fields read as the identity, so a
  // move-tool drag records only `dx`/`dy`. `clone` / `healing_brush` /
  // `patch` steps reuse `dx`/`dy` as the source offset: covered pixel `p`
  // reads from `p + [dx, dy]`.
  /** Horizontal translation in image px. Absent ⇒ 0. */
  dx?: number;
  /** Vertical translation in image px. Absent ⇒ 0. */
  dy?: number;
  /** Uniform scale factor about the canvas centre. Absent ⇒ 1. */
  scale?: number;
  /** Rotation in degrees (clockwise) about the canvas centre. Absent ⇒ 0. */
  rotate?: number;
}

/**
 * Fields shared by every entry on the ordered edit stack. `disabled` steps
 * stay recorded (visible in the history panel, re-enable at any time) but are
 * skipped on replay by both the proxy preview and the backend.
 */
export interface EditOpBase {
  disabled?: boolean;
  /**
   * The marquee selection active when the step was recorded (PS selection
   * semantics): replay confines the step's effect to this image-space
   * `[x1, y1, x2, y2]` region (elliptical when `ellipse`), by both the proxy
   * preview and the backend.
   */
  clip?: { region: [number, number, number, number]; ellipse?: boolean };
}

/** An `EditPath` entry on the ordered edit stack. */
export type PathOp = EditPath & EditOpBase & { type: "path" };

/** A `BrushStroke` entry on the ordered edit stack. */
export type BrushOp = BrushStroke & EditOpBase & { type: "brush" };

/**
 * One step of the ordered edit stack (see
 * `docs/design/ps-editor-architecture.md`, M1): a vector path, a brush /
 * eraser stroke, or a queued morphology / selection operation. The
 * discriminant is `type` — `"path"` / `"brush"` are the geometry ops, every
 * other value is a `MaskOperation` kind (`wand` / `invert` / `feather` / …).
 */
export type EditOp = PathOp | BrushOp | (MaskOperation & EditOpBase);

/**
 * Re-editable record of all manual edits for the Subject Mask card. Stored on
 * the node as the `edit_paths` param and round-tripped through the workflow
 * file. Mirrors the Rust `EditPaths` schema.
 *
 * Version 2: the edits are one ordered `ops` stack (replayed in recorded
 * order) instead of per-kind arrays. A version-1 value (separate `paths` /
 * `brush_strokes` / `operations` arrays) is migrated on load by
 * `normalizeEditPaths`, preserving the legacy replay order (paths, then
 * strokes, then operations). Version 3 (`MaskDocument`) wraps this in a layer
 * stack; a v1/v2 value loads as a single-layer document.
 */
export interface EditPaths {
  version: 2;
  /** The ordered edit stack, replayed by the backend in recorded order. */
  ops: EditOp[];
  /**
   * Trimap "unknown band" strokes for alpha matting (same shape as brush
   * strokes). When present, the backend paints these regions as the trimap
   * *unknown* level on top of the auto `matting_band_px` ring, so the matter
   * (ViTMatte / builtin guided filter) resolves soft alpha exactly where the
   * user marked hair / fur / glass. Non-empty ⇒ matting runs even if the
   * node's `alpha_matting` toggle is off. Read as `edit_paths.matte_strokes`.
   * Not on the `ops` stack: they parameterise the matting pass, they are not
   * a sequential mask edit.
   */
  matte_strokes: BrushStroke[];
  /**
   * SAM 2 point prompts in image-pixel space. When an auto mode runs with at
   * least one *positive* point, the backend routes to the interactive SAM 2
   * segmenter ("segment what the user clicked / not"); empty ⇒ the prompt-free
   * salient / builtin pipeline. Each point carries a `label`: `1` includes
   * (foreground), `0` excludes (background). Read by the Rust backend as
   * `edit_paths.points`; a legacy `[x, y]` pair is read as a positive point.
   */
  points: PointPrompt[];
}

/**
 * A SAM 2 point prompt: an image-space location plus whether it includes or
 * excludes that region. Mirrors SAM 2's `point_labels` (1 = positive /
 * foreground, 0 = negative / background).
 */
export interface PointPrompt {
  x: number;
  y: number;
  /** `1` = positive (include), `0` = negative (exclude). */
  label: 0 | 1;
}

export function emptyEditPaths(): EditPaths {
  return { version: 2, ops: [], matte_strokes: [], points: [] };
}

/** Blend modes the M3 compositor supports (grayscale mask surfaces). */
export const LAYER_BLENDS = ["normal", "multiply", "screen", "darken", "lighten", "difference"] as const;
export type LayerBlend = (typeof LAYER_BLENDS)[number];

/**
 * Lightweight visual grouping for the layer panel. This is not a Photoshop
 * folder and does not change stack order or compositing; it only tags layers
 * with a stable name/colour so related layers are easier to find.
 */
export interface LayerGroup {
  id: string;
  name: string;
  color: string;
}

/**
 * Tone-mapping kinds an adjustment layer can carry (M6). The document is
 * grayscale (mask surfaces), so the PS set maps to the greyscale tone curve:
 * `levels` (input / gamma / output), a free `curve` (control points → LUT),
 * and `brightness_contrast`.
 *
 * The image workspace (image-kernel K2) additionally records colour
 * adjustments — `color_ranges` (the unified selective-colour / B&W /
 * hue-sat tool) and `channel_mixer`. These render through the grade
 * kernel only; the greyscale mask compositor ignores them (its LUT
 * builder returns identity for unknown kinds).
 */
export type AdjustmentType =
  | "levels"
  | "curve"
  | "brightness_contrast"
  | "color_ranges"
  | "channel_mixer"
  | "replace_color";

/** A named colour range of the `color_ranges` adjustment. */
export type AdjustmentColorRange =
  | "reds"
  | "yellows"
  | "greens"
  | "cyans"
  | "blues"
  | "magentas"
  | "whites"
  | "neutrals"
  | "blacks";

/** Per-range deltas of the `color_ranges` adjustment (UI units). */
export interface AdjustmentRange {
  range: AdjustmentColorRange;
  /** Hue shift in degrees, −180..180. Absent ⇒ 0. */
  hue?: number;
  /** Saturation delta in percent, −100..100. Absent ⇒ 0. */
  saturation?: number;
  /** Lightness delta in percent, −100..100. Absent ⇒ 0. */
  lightness?: number;
}

/**
 * The revisable parameters of an adjustment layer (M6). Each field defaults
 * to its identity when absent, so a freshly added adjustment layer is a
 * no-op until tuned. Both the proxy preview (`maskMorphology.ts`) and the
 * Rust compositor (`subject_mask.rs`) build the same 256-entry LUT from
 * these params, so the preview cannot drift from the run.
 */
export interface LayerAdjustment {
  type: AdjustmentType;
  // --- levels -----------------------------------------------------------
  /** Input black point, 0..255. Absent ⇒ 0. */
  in_black?: number;
  /** Input white point, 0..255. Absent ⇒ 255. */
  in_white?: number;
  /** Midtone gamma (>0; 1 = linear). Absent ⇒ 1. */
  gamma?: number;
  /** Output black point, 0..255. Absent ⇒ 0. */
  out_black?: number;
  /** Output white point, 0..255. Absent ⇒ 255. */
  out_white?: number;
  // --- curve --------------------------------------------------------------
  /** Curve control points `[x, y]` (0..255), piecewise-linear. Absent / <2 ⇒ identity. */
  points?: [number, number][];
  // --- brightness_contrast ------------------------------------------------
  /** −100..100; +100 shifts the whole range up by 255. Absent ⇒ 0. */
  brightness?: number;
  /** −100..100; scales values about the midpoint (127.5). Absent ⇒ 0. */
  contrast?: number;
  // --- color_ranges (image workspace) --------------------------------------
  /** Per-range deltas; absent ranges are identity. */
  ranges?: AdjustmentRange[];
  /** Desaturate after the range deltas (B&W mix). Absent ⇒ false. */
  monochrome?: boolean;
  // --- channel_mixer (image workspace) --------------------------------------
  /** Output-red weights `[from R, from G, from B]` in percent. Absent ⇒ [100, 0, 0]. */
  red?: [number, number, number];
  /** Output-green weights in percent. Absent ⇒ [0, 100, 0]. */
  green?: [number, number, number];
  /** Output-blue weights in percent. Absent ⇒ [0, 0, 100]. */
  blue?: [number, number, number];
  // --- replace_color (image workspace) --------------------------------------
  /** The colour to replace, as `#rrggbb`. Absent ⇒ not yet picked (identity). */
  from_color?: string;
  /** The replacement colour, as `#rrggbb`. Absent ⇒ not yet picked (identity). */
  to_color?: string;
  /** Match tolerance in percent, 0..100. Absent ⇒ 40. */
  fuzziness?: number;
  /** Replacement strength in percent, 0..100. Absent ⇒ 100. */
  strength?: number;
}

/**
 * One layer of the mask document (see `docs/design/ps-editor-architecture.md`,
 * M3). Each layer owns its own ordered edit stack. The bottom layer (index 0)
 * is the background: its ops replay directly onto the node's base mask, so a
 * single-layer document rasterises byte-identically to the pre-M3 flow.
 * Layers above rasterise from an empty surface and composite onto the result
 * per `blend` + `opacity`.
 */
export interface MaskLayer {
  id: string;
  name: string;
  /**
   * `"mask"` layers own an edit stack and composite per blend + opacity;
   * `"adjustment"` layers (M6) carry a `LayerAdjustment` tone map applied to
   * the composite below them (their `ops` / `blend` are ignored). `"pixel"`
   * is reserved by the document model.
   */
  kind: "mask" | "adjustment";
  blend: LayerBlend;
  /** 0..1 layer opacity. */
  opacity: number;
  visible: boolean;
  /** PS "lock all": a locked layer rejects new edits and deletion. */
  locked?: boolean;
  /** PS layer link: transforms recorded on one linked layer mirror to all. */
  linked?: boolean;
  /** Optional visual group tag; absent means the layer keeps the default row style. */
  groupId?: string;
  /** The layer's ordered edit stack, replayed in recorded order. */
  ops: EditOp[];
  /** The tone map an `"adjustment"` layer applies (revisable at any time). */
  adjustment?: LayerAdjustment;
}

/** Resampling filter for the document-level image-size request. */
export type ImageResample = "auto" | "nearest" | "bilinear" | "bicubic";

/** PS Image Size (Ctrl+Alt+I): the requested output pixel size. */
export interface ImageCanvasSize {
  w: number;
  h: number;
  resample: ImageResample;
}

/**
 * Version-3 `edit_paths` envelope: the mask document. `matte_strokes` and
 * `points` stay document-level — they parameterise the matting pass / SAM 2
 * prompt, not a per-layer sequential edit. Layers are bottom-up.
 */
export interface MaskDocument {
  version: 3;
  layers: MaskLayer[];
  /** Index of the layer receiving new edits. */
  active: number;
  matte_strokes: BrushStroke[];
  points: PointPrompt[];
  /** Requested output size (PS Image Size); absent ⇒ keep the source size. */
  canvas?: ImageCanvasSize;
  /** Visual layer tags. Empty means every layer keeps the default row style. */
  layerGroups: LayerGroup[];
}

export function emptyMaskLayer(name = "Background"): MaskLayer {
  return {
    id: `layer-${Math.random().toString(36).slice(2, 10)}`,
    name,
    kind: "mask",
    blend: "normal",
    opacity: 1,
    visible: true,
    ops: [],
  };
}

/** A fresh identity adjustment layer of the given tone-map kind (M6). */
export function emptyAdjustmentLayer(type: AdjustmentType, name?: string): MaskLayer {
  return {
    ...emptyMaskLayer(name ?? type),
    kind: "adjustment",
    adjustment: { type },
  };
}

export function emptyMaskDocument(): MaskDocument {
  return { version: 3, layers: [emptyMaskLayer()], active: 0, matte_strokes: [], points: [], layerGroups: [] };
}

/** The layer new edits are recorded onto (always present, clamped). */
export function activeLayer(doc: MaskDocument): MaskLayer {
  return doc.layers[Math.min(Math.max(doc.active, 0), doc.layers.length - 1)];
}

export function isPathOp(op: EditOp): op is PathOp {
  return op.type === "path";
}

export function isBrushOp(op: EditOp): op is BrushOp {
  return op.type === "brush";
}

export function isMaskOperation(op: EditOp): op is MaskOperation {
  return op.type !== "path" && op.type !== "brush";
}

/** The vector paths on the edit stack, in stack order. */
export function editStackPaths(edits: EditPaths): EditPath[] {
  return edits.ops.filter(isPathOp);
}

/** The brush / eraser strokes on the edit stack, in stack order. */
export function editStackBrushStrokes(edits: EditPaths): BrushStroke[] {
  return edits.ops.filter(isBrushOp);
}

/** The queued morphology / selection operations on the edit stack, in stack order. */
export function editStackOperations(edits: EditPaths): MaskOperation[] {
  return edits.ops.filter(isMaskOperation);
}

/** A subject detected by a Phase 2 model (empty in Phase 1). */
export interface DetectedSubject {
  label: string;
  confidence: number;
  /** `[x1, y1, x2, y2]` in image pixels. */
  bbox: [number, number, number, number];
}

/** Provenance + operations record for a matte run (mirrors Rust `matte_report`). */
export interface MatteReport {
  mode: string;
  /** `rust-native` in Phase 1, the model id (e.g. `birefnet`) in Phase 2. */
  provider: string;
  source_mode: string;
  exif_transposed: boolean;
  max_decode_pixels: number;
  image_size: [number, number];
  mask_coverage: number;
  detected_subjects: DetectedSubject[];
  operations: { type: string; [k: string]: unknown }[];
  /** Completeness flag for the mask / alpha / cutout triplet. */
  triplet: { mask: boolean; alpha_image: boolean; cutout_image: boolean };
  processing_time_ms: number;
}

/** Result of a Subject Mask run (mirrors Rust `SubjectMaskResult`). */
export interface SubjectMaskResult {
  mask_path: string;
  alpha_image_path: string;
  cutout_image_path: string;
  edit_paths_path: string;
  matte_report: MatteReport;
}

/** End-to-end production workflow tracking, written alongside an export. */
export interface ProductionMetadata {
  workflow_id: string;
  source_psd: string;
  provider_profile: string;
  prompt: string;
  prompt_suffix: string;
  generated_files: string[];
  enhance_steps: string[];
  quality_report: QualityReport | null;
  exported: ExportedArtifacts;
}
