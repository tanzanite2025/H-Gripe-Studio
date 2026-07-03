// Layered image asset protocol (docs/plans/active/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md).
//
// A `LayeredImageAsset` is the project-internal result of splitting a flat
// image into editable production layers; PSD is only one import/export format
// of it. This file is protocol-first: it fixes the data model plus a
// deterministic stub builder (original locked layer + background/subject
// candidates with placeholder masks) so the node canvas, Review Editor, Grade
// and Timeline can all reference the same asset shape before any real
// segmentation engine lands. Fields stay snake_case: the same JSON round-trips
// through the Rust `smartLayerSplit` graph node (studio/layer_split.rs).

/** A reference to an image file on disk. */
export interface ImageRef {
  path: string;
  width?: number;
  height?: number;
}

export type LayerCandidateKind =
  | "subject"
  | "background"
  | "object"
  | "person"
  | "face"
  | "hair"
  | "clothing"
  | "product"
  | "text"
  | "logo"
  | "shadow"
  | "reflection"
  | "sky"
  | "foreground"
  | "unknown";

export type LayerCandidateSource = "model" | "algorithm" | "user" | "mixed";

/** One editable layer proposal inside a layered image asset. */
export interface LayerCandidate {
  id: string;
  name: string;
  kind: LayerCandidateKind;
  /** `[x1, y1, x2, y2]` in canvas pixels (`[0,0,0,0]` = unknown). */
  bbox: [number, number, number, number];
  mask: ImageRef;
  rgba?: ImageRef;
  confidence: number;
  source: LayerCandidateSource;
  visible: boolean;
  locked?: boolean;
  notes?: string[];
}

/** A per-layer issue the Review Editor should surface before confirmation. */
export interface ReviewIssue {
  layer_id: string;
  severity: "info" | "warning" | "error";
  message: string;
}

/** Diagnostics kept with the asset so a split can be re-run and compared. */
export interface LayerSplitReport {
  engine_version: string;
  created_at: string;
  warnings: string[];
  suggested_review: ReviewIssue[];
}

/** A flat image converted into editable production layers. */
export interface LayeredImageAsset {
  id: string;
  source_asset_id: string;
  source_node_id?: string;
  canvas: {
    width: number;
    height: number;
    color_space: "srgb" | "display-p3" | "unknown";
  };
  base_image: ImageRef;
  preview_composite: ImageRef;
  layers: LayerCandidate[];
  split_report: LayerSplitReport;
}

/** Engine tag written by the protocol stub (keep in sync with layer_split.rs). */
export const LAYER_SPLIT_STUB_ENGINE = "layer-split-stub/0.1";

export const STUB_ORIGINAL_LAYER_ID = "layer_original";
export const STUB_BACKGROUND_LAYER_ID = "layer_background";
export const STUB_SUBJECT_LAYER_ID = "layer_subject";

/**
 * Wrap a flat image into the stub `LayeredImageAsset`: a locked original layer
 * plus low-confidence background/subject candidates whose masks are the source
 * image itself (placeholders until a real segmentation engine replaces them).
 */
export function stubLayeredImageAsset(opts: {
  imagePath: string;
  nodeId: string;
  createdAt?: string;
}): LayeredImageAsset {
  const image: ImageRef = { path: opts.imagePath };
  const placeholderNote = "placeholder mask (protocol stub)";
  const candidate = (
    id: string,
    name: string,
    kind: LayerCandidateKind,
  ): LayerCandidate => ({
    id,
    name,
    kind,
    bbox: [0, 0, 0, 0],
    mask: image,
    rgba: image,
    confidence: 0.25,
    source: "algorithm",
    visible: true,
    notes: [placeholderNote],
  });
  const layers: LayerCandidate[] = [
    {
      id: STUB_ORIGINAL_LAYER_ID,
      name: "original image",
      kind: "unknown",
      bbox: [0, 0, 0, 0],
      mask: image,
      rgba: image,
      confidence: 1,
      source: "algorithm",
      visible: true,
      locked: true,
      notes: ["locked original (protocol stub)"],
    },
    candidate(STUB_BACKGROUND_LAYER_ID, "background candidate", "background"),
    candidate(STUB_SUBJECT_LAYER_ID, "subject candidate", "subject"),
  ];
  return {
    id: `layered-${opts.nodeId}`,
    source_asset_id: opts.imagePath,
    source_node_id: opts.nodeId,
    canvas: { width: 0, height: 0, color_space: "unknown" },
    base_image: image,
    preview_composite: image,
    layers,
    split_report: {
      engine_version: LAYER_SPLIT_STUB_ENGINE,
      created_at: opts.createdAt ?? String(Date.now()),
      warnings: ["stub split: placeholder masks, no real segmentation"],
      suggested_review: [
        {
          layer_id: STUB_BACKGROUND_LAYER_ID,
          severity: "warning",
          message: "placeholder mask — review before production use",
        },
        {
          layer_id: STUB_SUBJECT_LAYER_ID,
          severity: "warning",
          message: "placeholder mask — review before production use",
        },
      ],
    },
  };
}

/** Find a layer by id, or null when the asset does not carry it. */
export function findLayer(
  asset: LayeredImageAsset,
  layerId: string,
): LayerCandidate | null {
  return asset.layers.find((layer) => layer.id === layerId) ?? null;
}
