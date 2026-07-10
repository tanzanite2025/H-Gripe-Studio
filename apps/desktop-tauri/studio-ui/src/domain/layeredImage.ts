// Layered image asset protocol (docs/plans/completed/IMAGE_TO_LAYERED_PSD_PIPELINE_PLAN.md).
//
// A `LayeredImageAsset` is the project-internal result of splitting a flat
// image into editable production layers; PSD is only one import/export format
// of it. This file is protocol-first: it fixes the data model plus a
// deterministic stub builder (original locked layer + background/subject
// candidates with placeholder masks) used by the browser preview; the desktop
// runtime's `smartLayerSplit` compute node (studio/layer_split.rs) emits the
// same shape with real segmented masks. Fields stay snake_case: the same JSON
// round-trips through both runtimes.

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
  /** Keep these pixels untouched when editing other layers (Phase 3 文字/logo). */
  protected?: boolean;
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

/**
 * Validate an untyped run output as a `LayeredImageAsset` (structural check of
 * the fields the UI relies on). The desktop runtime's `smartLayerSplit` emits
 * this shape on its `layered_asset` port; anything else yields `null` so the
 * caller can fall back to the stub.
 */
export function parseLayeredImageAsset(value: unknown): LayeredImageAsset | null {
  if (typeof value !== "object" || value === null) return null;
  const asset = value as Record<string, unknown>;
  const canvas = asset.canvas as Record<string, unknown> | undefined;
  const imageRef = (v: unknown): v is ImageRef =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).path === "string";
  if (
    typeof asset.id !== "string" ||
    typeof asset.source_asset_id !== "string" ||
    typeof canvas !== "object" ||
    canvas === null ||
    typeof canvas.width !== "number" ||
    typeof canvas.height !== "number" ||
    !imageRef(asset.base_image) ||
    !imageRef(asset.preview_composite) ||
    !Array.isArray(asset.layers) ||
    typeof asset.split_report !== "object" ||
    asset.split_report === null
  ) {
    return null;
  }
  for (const layer of asset.layers) {
    const l = layer as Record<string, unknown>;
    if (
      typeof l !== "object" ||
      l === null ||
      typeof l.id !== "string" ||
      typeof l.name !== "string" ||
      typeof l.kind !== "string" ||
      !imageRef(l.mask)
    ) {
      return null;
    }
  }
  return value as LayeredImageAsset;
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

/**
 * Flatten an asset into the first-version export manifest (basic layer names,
 * bbox and alpha refs) recorded in PSD Export's `_metadata.json`.
 */
export function layeredAssetManifest(asset: LayeredImageAsset): {
  asset_id: string;
  source_asset_id: string;
  engine_version: string;
  canvas: LayeredImageAsset["canvas"];
  composite_preview: string;
  layers: {
    id: string;
    name: string;
    kind: LayerCandidateKind;
    bbox: [number, number, number, number];
    alpha: string;
    locked: boolean;
    confidence: number;
  }[];
} {
  return {
    asset_id: asset.id,
    source_asset_id: asset.source_asset_id,
    engine_version: asset.split_report.engine_version,
    canvas: asset.canvas,
    composite_preview: asset.preview_composite.path,
    layers: asset.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      bbox: layer.bbox,
      alpha: layer.mask.path,
      locked: layer.locked ?? false,
      confidence: layer.confidence,
    })),
  };
}

/**
 * Apply a Review Editor "merge layers" to an asset: replace the (unlocked)
 * merged layers with one user-sourced layer carrying the merged artifacts, at
 * the position of the first merged layer. Confidence is the minimum of the
 * merged candidates; the merged layer is flagged for review in the report.
 * Pure asset transformation — the pixel artifacts come from the backend's
 * `merge_layer_masks` command.
 */
export function mergeLayersIntoAsset(
  asset: LayeredImageAsset,
  layerIds: string[],
  merged: {
    id: string;
    name: string;
    mask: ImageRef;
    rgba: ImageRef;
    bbox: [number, number, number, number];
  },
): LayeredImageAsset {
  const ids = new Set(layerIds);
  const members = asset.layers.filter((layer) => ids.has(layer.id) && !layer.locked);
  if (members.length < 2) return asset;
  const memberIds = new Set(members.map((layer) => layer.id));
  const mergedLayer: LayerCandidate = {
    id: merged.id,
    name: merged.name,
    kind: members.every((layer) => layer.kind === members[0].kind) ? members[0].kind : "object",
    bbox: merged.bbox,
    mask: merged.mask,
    rgba: merged.rgba,
    confidence: Math.min(...members.map((layer) => layer.confidence)),
    source: "user",
    visible: true,
    notes: [`merged from ${members.map((layer) => layer.name).join(" + ")}`],
  };
  const layers: LayerCandidate[] = [];
  let inserted = false;
  for (const layer of asset.layers) {
    if (memberIds.has(layer.id)) {
      if (!inserted) {
        layers.push(mergedLayer);
        inserted = true;
      }
      continue;
    }
    layers.push(layer);
  }
  return {
    ...asset,
    layers,
    split_report: {
      ...asset.split_report,
      suggested_review: [
        ...asset.split_report.suggested_review.filter((issue) => !memberIds.has(issue.layer_id)),
        {
          layer_id: mergedLayer.id,
          severity: "info",
          message: `merged from ${members.length} layers — review the union mask`,
        },
      ],
    },
  };
}

/**
 * Apply a Review Editor "split layer" to an asset: replace the (unlocked)
 * split layer with the user-sourced part layers at its position. Parts trust
 * a bit less than their source layer (connected components can cut one object
 * in two) and each part is flagged for review. Pure asset transformation —
 * the pixel artifacts come from the backend's `split_layer_mask` command.
 */
export function splitLayerInAsset(
  asset: LayeredImageAsset,
  layerId: string,
  parts: {
    id: string;
    name: string;
    mask: ImageRef;
    rgba: ImageRef;
    bbox: [number, number, number, number];
  }[],
): LayeredImageAsset {
  const source = findLayer(asset, layerId);
  if (!source || source.locked || parts.length < 2) return asset;
  const partLayers: LayerCandidate[] = parts.map((part) => ({
    id: part.id,
    name: part.name,
    kind: source.kind === "background" ? "background" : "object",
    bbox: part.bbox,
    mask: part.mask,
    rgba: part.rgba,
    confidence: Math.max(source.confidence - 0.15, 0.1),
    source: "user",
    visible: true,
    notes: [`split from ${source.name} (connected component)`],
  }));
  return {
    ...asset,
    layers: asset.layers.flatMap((layer) => (layer.id === layerId ? partLayers : [layer])),
    split_report: {
      ...asset.split_report,
      suggested_review: [
        ...asset.split_report.suggested_review.filter((issue) => issue.layer_id !== layerId),
        ...partLayers.map((layer) => ({
          layer_id: layer.id,
          severity: "warning" as const,
          message: "split part — verify it is one whole object",
        })),
      ],
    },
  };
}

/**
 * Apply a Review Editor "mark protected" toggle to an asset: set or clear the
 * (unlocked) layer's `protected` flag so downstream edits keep its pixels.
 * Pure asset transformation — no artifacts change.
 */
export function setLayerProtected(
  asset: LayeredImageAsset,
  layerId: string,
  isProtected: boolean,
): LayeredImageAsset {
  const layer = findLayer(asset, layerId);
  if (!layer || layer.locked || (layer.protected ?? false) === isProtected) return asset;
  return {
    ...asset,
    layers: asset.layers.map((l) =>
      l.id === layerId ? { ...l, protected: isProtected } : l,
    ),
  };
}

/** Find a layer by id, or null when the asset does not carry it. */
export function findLayer(
  asset: LayeredImageAsset,
  layerId: string,
): LayerCandidate | null {
  return asset.layers.find((layer) => layer.id === layerId) ?? null;
}
