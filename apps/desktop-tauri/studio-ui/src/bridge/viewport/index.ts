import { viewportClient } from "./client";
import type {
  LayeredAssetLayerRef,
  TimelineClipRef,
  ViewportFrameExportFormat,
  ViewportKind,
  ViewportMaskOverlay,
  ViewportOverlayScene,
  ViewportPlacement,
  ViewportTarget,
} from "./contracts";

export * from "./contracts";

export function createViewport(kind: ViewportKind) {
  return viewportClient().createViewport(kind);
}

export function destroyViewport(viewportId: string) {
  return viewportClient().destroyViewport(viewportId);
}

export function setViewportTarget(viewportId: string, target: ViewportTarget) {
  return viewportClient().setViewportTarget(viewportId, target);
}

export function registerLayeredAsset(assetId: string, layers: LayeredAssetLayerRef[]) {
  return viewportClient().registerLayeredAsset(assetId, layers);
}

export function unregisterLayeredAsset(assetId: string) {
  return viewportClient().unregisterLayeredAsset(assetId);
}

export function registerTimeline(timelineId: string, clips: TimelineClipRef[]) {
  return viewportClient().registerTimeline(timelineId, clips);
}

export function unregisterTimeline(timelineId: string) {
  return viewportClient().unregisterTimeline(timelineId);
}

export function registerNodeOutput(nodeId: string, path: string, outputPort?: string) {
  return viewportClient().registerNodeOutput(nodeId, path, outputPort);
}

export function unregisterNodeOutput(nodeId: string) {
  return viewportClient().unregisterNodeOutput(nodeId);
}

export function resizeViewport(viewportId: string, width: number, height: number) {
  return viewportClient().resizeViewport(viewportId, width, height);
}

export function exportViewportFrame(
  viewportId: string,
  path: string,
  format: ViewportFrameExportFormat,
) {
  return viewportClient().exportViewportFrame(viewportId, path, format);
}

export function setViewportGrade(
  viewportId: string,
  doc: unknown | null,
  temporalDenoise = 0,
) {
  return viewportClient().setViewportGrade(viewportId, doc, temporalDenoise);
}

export function setViewportClipProps(viewportId: string, doc: string | null, timeSec = 0) {
  return viewportClient().setViewportClipProps(viewportId, doc, timeSec);
}

export function setViewportMaskOverlay(
  viewportId: string,
  overlay: ViewportMaskOverlay | null,
) {
  return viewportClient().setViewportMaskOverlay(viewportId, overlay);
}

export function setViewportOverlayScene(
  viewportId: string,
  scene: ViewportOverlayScene | null,
) {
  return viewportClient().setViewportOverlayScene(viewportId, scene);
}

export function setViewportView(viewportId: string, zoom: number, panX: number, panY: number) {
  return viewportClient().setViewportView(viewportId, zoom, panX, panY);
}

export function presentViewportView(
  viewportId: string,
  zoom: number,
  panX: number,
  panY: number,
) {
  return viewportClient().presentViewportView(viewportId, zoom, panX, panY);
}

export function renderViewportFrame(viewportId: string) {
  return viewportClient().renderViewportFrame(viewportId);
}

export function readViewportPixels(viewportId: string) {
  return viewportClient().readViewportPixels(viewportId);
}

export function setViewportPlacement(viewportId: string, placement: ViewportPlacement) {
  return viewportClient().setViewportPlacement(viewportId, placement);
}

export function setViewportPresented(viewportId: string, presented: boolean) {
  return viewportClient().setViewportPresented(viewportId, presented);
}
