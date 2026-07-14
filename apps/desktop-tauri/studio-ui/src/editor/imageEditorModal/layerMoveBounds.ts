import type { ImageEditorDocument, ImageEditorLayer } from "../../contracts/imageEditorDocument";
import { layerCompositeTransform } from "../imageLayerGeometry";
import { layerSourceImageOp } from "../imageLayerSource";
import type { SceneFrame } from "./sceneFrame";
import type { Pt } from "./pointer/types";

type Rect = readonly [number, number, number, number];

const IDENTITY = { dx: 0, dy: 0, scale: 1, rotate: 0 };

function transformedLayerAabb(
  layer: ImageEditorLayer,
  dims: { w: number; h: number },
): Rect | null {
  const placement = layerSourceImageOp(layer)?.placement;
  if (!placement) return null;
  const transform = layerCompositeTransform(layer) ?? IDENTITY;
  if (
    ![transform.dx, transform.dy, transform.scale, transform.rotate].every(Number.isFinite)
    || transform.scale <= 0
  ) {
    return null;
  }
  const cx = Math.max(1, dims.w) / 2;
  const cy = Math.max(1, dims.h) / 2;
  const radians = transform.rotate * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const point = (x: number, y: number): Pt => {
    const sx = (x - cx) * transform.scale;
    const sy = (y - cy) * transform.scale;
    return [
      cx + sx * cos - sy * sin + transform.dx,
      cy + sx * sin + sy * cos + transform.dy,
    ];
  };
  const [x0, y0, x1, y1] = placement;
  const points = [point(x0, y0), point(x1, y0), point(x1, y1), point(x0, y1)];
  return [
    Math.min(...points.map(([x]) => x)),
    Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)),
    Math.max(...points.map(([, y]) => y)),
  ];
}

function affectedLayers(document: ImageEditorDocument): ImageEditorLayer[] | null {
  const selected = document.layers[document.active];
  if (!selected || selected.kind !== "pixel" || selected.locked || !layerSourceImageOp(selected)) {
    return null;
  }
  if (!selected.linked) return [selected];
  return document.layers.filter((layer) => (
    layer.kind === "pixel"
    && layer.linked
    && !layer.locked
    && Boolean(layerSourceImageOp(layer))
  ));
}

function clampAxis(
  desired: number,
  contentMin: number,
  contentMax: number,
  boundaryMin: number,
  boundaryMax: number,
): number {
  const contentSize = contentMax - contentMin;
  const boundarySize = boundaryMax - boundaryMin;
  const minimum = contentSize <= boundarySize
    ? boundaryMin - contentMin
    : boundaryMax - contentMax;
  const maximum = contentSize <= boundarySize
    ? boundaryMax - contentMax
    : boundaryMin - contentMin;
  return Math.min(Math.max(desired, minimum), maximum);
}

/** Resolve the only move delta used by both the live preview and history op. */
export function clampSelectedLayerMoveDelta(
  document: ImageEditorDocument,
  dims: { w: number; h: number },
  pasteboard: SceneFrame,
  desired: Pt,
): Pt | null {
  if (!desired.every(Number.isFinite)) return null;
  const layers = affectedLayers(document);
  if (!layers || layers.length === 0) return null;
  const bounds = layers.map((layer) => transformedLayerAabb(layer, dims));
  if (bounds.some((rect) => rect === null)) return null;
  const valid = bounds as Rect[];
  const envelope: Rect = [
    Math.min(...valid.map((rect) => rect[0])),
    Math.min(...valid.map((rect) => rect[1])),
    Math.max(...valid.map((rect) => rect[2])),
    Math.max(...valid.map((rect) => rect[3])),
  ];
  const right = pasteboard.x + pasteboard.w;
  const bottom = pasteboard.y + pasteboard.h;
  return [
    clampAxis(desired[0], envelope[0], envelope[2], pasteboard.x, right),
    clampAxis(desired[1], envelope[1], envelope[3], pasteboard.y, bottom),
  ];
}
