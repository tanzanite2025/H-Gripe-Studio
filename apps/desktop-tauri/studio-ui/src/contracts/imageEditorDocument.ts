import type { BrushStroke, EditOp, PointPrompt } from "./imageEditOps";

export const LAYER_BLENDS = [
  "normal",
  "multiply",
  "screen",
  "darken",
  "lighten",
  "difference",
] as const;

export type LayerBlend = (typeof LAYER_BLENDS)[number];

/** Lightweight visual grouping for the layer panel. */
export interface LayerGroup {
  id: string;
  name: string;
  color: string;
}

export type AdjustmentType =
  | "levels"
  | "curve"
  | "brightness_contrast"
  | "color_ranges"
  | "channel_mixer"
  | "replace_color";

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

export interface AdjustmentRange {
  range: AdjustmentColorRange;
  hue?: number;
  saturation?: number;
  lightness?: number;
}

/** Revisable parameters carried by an adjustment layer. */
export interface LayerAdjustment {
  type: AdjustmentType;
  in_black?: number;
  in_white?: number;
  gamma?: number;
  out_black?: number;
  out_white?: number;
  points?: [number, number][];
  brightness?: number;
  contrast?: number;
  ranges?: AdjustmentRange[];
  monochrome?: boolean;
  red?: [number, number, number];
  green?: [number, number, number];
  blue?: [number, number, number];
  from_color?: string;
  to_color?: string;
  fuzziness?: number;
  strength?: number;
}

/** One layer of the image editor document. */
export interface ImageEditorLayer {
  id: string;
  name: string;
  kind: "pixel" | "adjustment";
  blend: LayerBlend;
  opacity: number;
  visible: boolean;
  locked?: boolean;
  linked?: boolean;
  groupId?: string;
  ops: EditOp[];
  adjustment?: LayerAdjustment;
  mask?: LayerMask;
}

/** A grayscale layer-mask attachment. */
export interface LayerMask {
  id: string;
  ops: EditOp[];
  disabled?: boolean;
  unlinked?: boolean;
}

export type LayerTargetKind = "pixel" | "mask";
export type ImageResample = "auto" | "nearest" | "bilinear" | "bicubic";

export interface ImageCanvasSize {
  w: number;
  h: number;
  resample: ImageResample;
}

/** Version-3 image editor document envelope. */
export interface ImageEditorDocument {
  version: 3;
  layers: ImageEditorLayer[];
  active: number;
  matte_strokes: BrushStroke[];
  points: PointPrompt[];
  canvas?: ImageCanvasSize;
  layerGroups: LayerGroup[];
  activeTarget?: LayerTargetKind;
}

export function emptyPixelLayer(name = "Background"): ImageEditorLayer {
  return {
    id: `layer-${Math.random().toString(36).slice(2, 10)}`,
    name,
    kind: "pixel",
    blend: "normal",
    opacity: 1,
    visible: true,
    ops: [],
  };
}

export function emptyAdjustmentLayer(type: AdjustmentType, name?: string): ImageEditorLayer {
  return {
    ...emptyPixelLayer(name ?? type),
    kind: "adjustment",
    adjustment: { type },
  };
}

export function emptyImageEditorDocument(): ImageEditorDocument {
  return {
    version: 3,
    layers: [emptyPixelLayer()],
    active: 0,
    matte_strokes: [],
    points: [],
    layerGroups: [],
  };
}

export function activeLayer(doc: ImageEditorDocument): ImageEditorLayer | undefined {
  return doc.layers[Math.min(Math.max(doc.active, 0), doc.layers.length - 1)];
}

export function emptyLayerMask(): LayerMask {
  return { id: `mask-${Math.random().toString(36).slice(2, 10)}`, ops: [] };
}

export function activeTargetKind(doc: ImageEditorDocument): LayerTargetKind {
  return doc.activeTarget === "mask" && activeLayer(doc)?.mask ? "mask" : "pixel";
}
