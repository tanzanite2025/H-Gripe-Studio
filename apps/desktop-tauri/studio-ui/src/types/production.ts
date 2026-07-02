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
  /** `pen` | `lasso`. */
  tool: string;
  closed: boolean;
  points: EditPathPoint[];
}

/** A freehand brush/eraser stroke (applied by the Rust backend on run). */
export interface BrushStroke {
  id: string;
  /** `add` (brush) | `subtract` (eraser). */
  mode: string;
  /** Stroke radius in image pixels. */
  radius: number;
  /** Polyline of `[x, y]` points the stroke passes through. */
  points: [number, number][];
}

/**
 * A recorded morphology / selection operation queued for the backend to apply
 * (in order) when the node runs. Phase 1 records the *intent* here rather than
 * re-implementing the exact Rust morphology in the webview, so the preview and
 * the executed result cannot drift.
 */
export interface MaskOperation {
  /** `wand` | `invert` | `fill_holes` | `smooth` | `grow` | `shrink` | `feather` | `rect` | `ellipse`. */
  type: string;
  /** Operation-specific scalar (tolerance / px / radius), when relevant. */
  amount?: number;
  /** `[x, y]` seed for `wand`, or `[x1, y1, x2, y2]` for marquee ops. */
  region?: number[];
}

/**
 * Fields shared by every entry on the ordered edit stack. `disabled` steps
 * stay recorded (visible in the history panel, re-enable at any time) but are
 * skipped on replay by both the proxy preview and the backend.
 */
export interface EditOpBase {
  disabled?: boolean;
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
 * strokes, then operations).
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
