// ImageDocument (image-kernel K1, docs/design/image-kernel.md §2, §5).
//
// The standalone image editor's document model: real pixel layers, grade
// adjustments, groups. Rendering (K2+) compiles this tree down to the grade
// kernel's layer stack; nothing here composites.
//
// K1 ships the model plus a lossless bridge to/from `ImageEditorDocument`, so the
// image workspace can move onto `ImageDocument` while today's stored drafts
// keep loading and committing byte-identically. The bridge is asserted to
// round-trip in `imageDocument.test.ts`.

import {
  LAYER_BLENDS,
  type ImageCanvasSize,
  type LayerAdjustment,
  type LayerBlend,
  type LayerGroup,
  type LayerMask,
  type LayerTargetKind,
  type ImageEditorDocument,
  type ImageEditorLayer,
} from "../contracts/imageEditorDocument";
import { type EditOp } from "../contracts/imageEditOps";
import type { GradeBlendMode, GradeOp } from "./gradeKernel";
import type { PersistedImageEditorState } from "./imageEditorState";

// Every image-editor blend is a grade-kernel blend (checked at compile
// time): the bridge can carry `blend` across unchanged.
const _imageEditorBlendIsGradeBlend: GradeBlendMode = null as unknown as LayerBlend;
void _imageEditorBlendIsGradeBlend;

/** Where a pixel layer's backing image comes from. */
export interface SourceRef {
  /** `"node"` (a node result via the preview pipeline) or `"file"`. */
  kind: "node" | "file";
  /** Node id or file path. */
  ref: string;
}

/** A grayscale coverage mask gating a layer (authored by the mask feature). */
export interface ImageLayerMask {
  /** Path to the mask image (a node's mask output or a saved edit). */
  path: string;
  /** Invert the coverage before gating. */
  inverted?: boolean;
}

export type ImageLayerKind =
  /**
   * Real pixels. `source` references the backing image; `edits` is the
   * revisable stroke / geometry stack (raster ops execute at K4 — until
   * then the mask kernel replays them, as today).
   */
  | { kind: "pixel"; source?: SourceRef; edits: EditOp[] }
  /**
   * Parameter-only layer applied to the composite below. An image-editor-bridged
   * layer carries the u8 `adjustment` tone map; K2 re-targets these onto
   * the grade kernel's f32 `ops` (levels → levels, curve → curves, …).
   * Exactly one of the two is populated.
   */
  | { kind: "adjustment"; adjustment?: LayerAdjustment; ops?: GradeOp[] }
  /** Group (新建组): children composite in isolation, then blend as one. */
  | { kind: "group"; children: ImageLayer[] };

export interface ImageLayer {
  id: string;
  name: string;
  layer: ImageLayerKind;
  blend: GradeBlendMode;
  /** 0..1 layer opacity. */
  opacity: number;
  visible: boolean;
  locked?: boolean;
  linked?: boolean;
  /** Optional visual group tag; absent means default layer-row styling. */
  groupId?: string;
  /** Layer mask gating the layer's effect (mask results land here). */
  mask?: ImageLayerMask;
  /** Editable layer-mask attachment: the mask's own edit stack (bridged
   * from the image editor document's `LayerMask`; `mask` above is a baked image). */
  layerMask?: LayerMask;
  /** Clipping mask (Alt+Ctrl+G): composite only inside the layer below. */
  clipped?: boolean;
}

/**
 * The image editor's document. Layers are bottom-up, like `ImageEditorDocument`.
 * Mask-feature inputs (`matte_strokes` / `points`) stay document-level so a
 * bridged image editor draft loses nothing.
 */
export interface ImageDocument {
  version: 1;
  layers: ImageLayer[];
  /** Index of the layer receiving new edits. */
  active: number;
  /** Requested output size (PS Image Size); absent ⇒ keep the source size. */
  canvas?: ImageCanvasSize;
  /** Carried through from a bridged image editor document (matting band strokes). */
  matte_strokes: ImageEditorDocument["matte_strokes"];
  /** Carried through from a bridged image editor document (built-in point prompts). */
  points: ImageEditorDocument["points"];
  /** Visual layer tags carried through the image editor document bridge. */
  layerGroups: LayerGroup[];
  /** Which attachment of the active layer receives new edits; absent ⇒ pixel. */
  activeTarget?: LayerTargetKind;
  /** Full editor snapshot timeline for reopening the image editor later. */
  editHistory?: PersistedImageEditorState;
}

export function emptyImageLayer(name = "Background"): ImageLayer {
  return {
    id: `layer-${Math.random().toString(36).slice(2, 10)}`,
    name,
    layer: { kind: "pixel", edits: [] },
    blend: "normal",
    opacity: 1,
    visible: true,
  };
}

export function emptyImageDocument(): ImageDocument {
  return { version: 1, layers: [emptyImageLayer()], active: 0, matte_strokes: [], points: [], layerGroups: [] };
}

// ---------------------------------------------------------------------------
// ImageEditorDocument bridge (K1) — lossless in both directions for documents that
// originated as image editor drafts. `fromImageEditorDocument(toImageEditorDocument(d)) ≡ d` for
// any bridgeable document (asserted by tests).
// ---------------------------------------------------------------------------

function fromImageEditorLayer(l: ImageEditorLayer): ImageLayer {
  const layer: ImageLayerKind =
    l.kind === "adjustment"
      ? { kind: "adjustment", adjustment: l.adjustment }
      : { kind: "pixel", edits: l.ops };
  return {
    id: l.id,
    name: l.name,
    layer,
    blend: l.blend,
    opacity: l.opacity,
    visible: l.visible,
    ...(l.locked !== undefined ? { locked: l.locked } : null),
    ...(l.linked !== undefined ? { linked: l.linked } : null),
    ...(l.groupId !== undefined ? { groupId: l.groupId } : null),
    ...(l.mask !== undefined ? { layerMask: l.mask } : null),
  };
}

/** Lift a stored image editor draft into the image-document model (always succeeds). */
export function fromImageEditorDocument(doc: ImageEditorDocument, editHistory?: PersistedImageEditorState): ImageDocument {
  return {
    version: 1,
    layers: doc.layers.map(fromImageEditorLayer),
    active: doc.active,
    ...(doc.canvas !== undefined ? { canvas: doc.canvas } : null),
    matte_strokes: doc.matte_strokes,
    points: doc.points,
    layerGroups: doc.layerGroups,
    ...(doc.activeTarget !== undefined ? { activeTarget: doc.activeTarget } : null),
    ...(editHistory !== undefined ? { editHistory } : null),
  };
}

/** Why one layer cannot lower to a `ImageEditorLayer`, or `null` when it can. */
function layerBridgeGap(l: ImageLayer): string | null {
  // Features ImageEditorDocument cannot express make the layer unbridgeable.
  if (l.mask) return "baked layer mask";
  if (l.clipped) return "clipping mask";
  if (l.layer.kind === "group") return "layer group";
  if (l.layer.kind === "adjustment" && l.layer.ops) return "grade ops";
  if (l.layer.kind === "pixel" && l.layer.source) return "pixel source ref";
  // The image model allows the full grade blend set; masks only `LAYER_BLENDS`.
  if (!(LAYER_BLENDS as readonly string[]).includes(l.blend)) return `blend "${l.blend}"`;
  return null;
}

/**
 * Why a document cannot lower to `ImageEditorDocument` (the first offending layer
 * and feature), or `null` when `toImageEditorDocument` will succeed. Callers that
 * drop a failed lowering should surface this so edits never vanish silently.
 */
export function imageEditorBridgeGap(doc: ImageDocument): string | null {
  for (const l of doc.layers) {
    const gap = layerBridgeGap(l);
    if (gap) return `layer "${l.name}": ${gap}`;
  }
  return null;
}

function toImageEditorLayer(l: ImageLayer): ImageEditorLayer | null {
  if (layerBridgeGap(l)) return null;
  if (l.layer.kind === "group") return null; // covered by the gap check; narrows the union
  const blend = l.blend as LayerBlend;
  const base = {
    id: l.id,
    name: l.name,
    blend,
    opacity: l.opacity,
    visible: l.visible,
    ...(l.locked !== undefined ? { locked: l.locked } : null),
    ...(l.linked !== undefined ? { linked: l.linked } : null),
    ...(l.groupId !== undefined ? { groupId: l.groupId } : null),
  };
  return l.layer.kind === "adjustment"
    ? { ...base, kind: "adjustment", ops: [], ...(l.layer.adjustment !== undefined ? { adjustment: l.layer.adjustment } : null) }
    : { ...base, kind: "pixel", ops: l.layer.edits, ...(l.layerMask !== undefined ? { mask: l.layerMask } : null) };
}

/**
 * Lower an image document back to the `edit_paths` v3 envelope, or `null`
 * when the document uses features `ImageEditorDocument` cannot express (groups,
 * layer masks, clipping, grade ops, non-image-editor blends). While the mask kernel
 * remains the executor (pre-K2), the image workspace only produces
 * bridgeable documents.
 */
export function toImageEditorDocument(doc: ImageDocument): ImageEditorDocument | null {
  const layers: ImageEditorLayer[] = [];
  for (const l of doc.layers) {
    const m = toImageEditorLayer(l);
    if (!m) return null;
    layers.push(m);
  }
  return {
    version: 3,
    layers,
    active: doc.active,
    matte_strokes: doc.matte_strokes,
    points: doc.points,
    ...(doc.canvas !== undefined ? { canvas: doc.canvas } : null),
    layerGroups: doc.layerGroups,
    ...(doc.activeTarget !== undefined ? { activeTarget: doc.activeTarget } : null),
  };
}
