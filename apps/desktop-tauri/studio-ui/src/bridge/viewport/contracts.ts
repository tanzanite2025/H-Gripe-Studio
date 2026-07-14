export type ViewportKind = "image_edit" | "grade_preview" | "video_preview";

export type ViewportTarget =
  | { kind: "image"; resourceId: string }
  | { kind: "image_layer"; assetId: string; layerId: string }
  | {
      kind: "image_composite";
      resourceId: string;
      document: unknown;
      documentKey: string;
      documentWidth: number;
      documentHeight: number;
      frameX?: number;
      frameY?: number;
      frameWidth?: number;
      frameHeight?: number;
    }
  | { kind: "video_clip"; timelineId: string; clipId: string; timeSec: number }
  | { kind: "video_frame"; resourceId: string; timeSec: number }
  | { kind: "node_output"; nodeId: string; outputPort?: string };

export interface ViewportBackend {
  requested: "auto" | "gpu" | "cpu";
  actual: "wgpu" | "gpu" | "cpu";
  detail?: string;
  fallback_reason?: string;
  decode_processing_time_ms?: number;
  props_backend?: "cpu" | "gpu";
  props_backend_detail?: string;
  props_fallback_reason?: string;
  props_processing_time_ms?: number;
  grade_processing_time_ms?: number;
}

export interface ViewportDescriptor {
  viewport_id: string;
  kind: ViewportKind;
  backend: ViewportBackend;
}

export interface ImageLayerScenePresentation {
  selectedLayerId: string;
  transactionId: string;
  baseDocumentKey: string;
  sequence: number;
  moveDraft: { dx: number; dy: number } | null;
}

export interface ViewportImageScene {
  document: unknown;
  documentKey: string;
  documentWidth: number;
  documentHeight: number;
  frameX: number;
  frameY: number;
  frameWidth: number;
  frameHeight: number;
}

export interface ViewportSelectedLayerFrame {
  owner: "selected-layer-frame";
  shape: "axis-aligned-rect";
  layerId: string;
  rect: [number, number, number, number];
  sourceRect: [number, number, number, number];
  source: "asset-frame";
}

export interface PresentedImageLayerScene {
  documentKey: string | null;
  transactionId: string | null;
  sequence: number | null;
}

export interface ViewportFrame {
  data_url: string;
  width: number;
  height: number;
  backend: ViewportBackend;
  presented: boolean;
  selectedLayerFrame: ViewportSelectedLayerFrame | null;
  documentKey: string | null;
  transactionId: string | null;
  sequence: number | null;
}

export type ViewportFrameExportFormat = "png" | "jpeg" | "bmp";

export interface ViewportFrameExportResult {
  path: string;
  width: number;
  height: number;
  format: ViewportFrameExportFormat;
}

export interface ViewportPixels {
  width: number;
  height: number;
  backend: ViewportBackend;
  pixels: Uint8Array;
}

export interface LayeredAssetLayerRef {
  layerId: string;
  rgbaPath: string;
}

export interface TimelineClipRef {
  clipId: string;
  kind: "video" | "still";
  path: string;
  startSec: number;
  durationSec: number;
}

export interface ViewportMaskOverlay {
  w: number;
  h: number;
  data: Uint8Array;
  rgb: [number, number, number];
  alpha: number;
  invert?: boolean;
}

export type ViewportOverlayItem =
  | {
      kind: "marquee";
      region: [number, number, number, number];
      ellipse?: boolean;
    }
  | {
      kind: "polygon";
      points: [number, number][];
      stroke: [number, number, number, number];
      fill?: [number, number, number, number];
      dash?: boolean;
    }
  | {
      kind: "polyline";
      points: [number, number][];
      stroke: [number, number, number, number];
      dash?: boolean;
    }
  | {
      kind: "band";
      points: [number, number][];
      radius: number;
      color: [number, number, number, number];
    }
  | {
      kind: "marker";
      center: [number, number];
      shape: "disc" | "cross" | "minus";
      size: number;
      stroke: [number, number, number, number];
      fill?: [number, number, number, number];
    };

export interface ViewportOverlayScene {
  items: ViewportOverlayItem[];
  phase?: number;
}

export interface ViewportPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
}

export interface ViewportPlacementReport {
  presented: boolean;
  fallback_reason?: string;
}

export interface ViewportClient {
  createViewport(kind: ViewportKind): Promise<ViewportDescriptor>;
  destroyViewport(viewportId: string): Promise<void>;
  setViewportTarget(viewportId: string, target: ViewportTarget): Promise<void>;
  registerLayeredAsset(assetId: string, layers: LayeredAssetLayerRef[]): Promise<void>;
  unregisterLayeredAsset(assetId: string): Promise<void>;
  registerTimeline(timelineId: string, clips: TimelineClipRef[]): Promise<void>;
  unregisterTimeline(timelineId: string): Promise<void>;
  registerNodeOutput(nodeId: string, path: string, outputPort?: string): Promise<void>;
  unregisterNodeOutput(nodeId: string): Promise<void>;
  resizeViewport(viewportId: string, width: number, height: number): Promise<void>;
  exportViewportFrame(
    viewportId: string,
    path: string,
    format: ViewportFrameExportFormat,
  ): Promise<ViewportFrameExportResult>;
  setViewportGrade(viewportId: string, doc: unknown | null, temporalDenoise?: number): Promise<void>;
  setViewportClipProps(viewportId: string, doc: string | null, timeSec?: number): Promise<void>;
  setViewportMaskOverlay(
    viewportId: string,
    overlay: ViewportMaskOverlay | null,
  ): Promise<void>;
  setViewportOverlayScene(
    viewportId: string,
    scene: ViewportOverlayScene | null,
  ): Promise<void>;
  setViewportImageScene(viewportId: string, scene: ViewportImageScene): Promise<void>;
  presentImageLayerScene(
    viewportId: string,
    presentation: ImageLayerScenePresentation,
  ): Promise<void>;
  setViewportView(viewportId: string, zoom: number, panX: number, panY: number): Promise<void>;
  presentViewportView(
    viewportId: string,
    zoom: number,
    panX: number,
    panY: number,
  ): Promise<boolean>;
  renderViewportFrame(viewportId: string): Promise<ViewportFrame>;
  readViewportPixels(viewportId: string): Promise<ViewportPixels>;
  setViewportPlacement(
    viewportId: string,
    placement: ViewportPlacement,
  ): Promise<ViewportPlacementReport>;
  setViewportPresented(viewportId: string, presented: boolean): Promise<void>;
}

export function decodeFramePayload(payload: ArrayBuffer | Uint8Array): ViewportFrame {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.byteLength < 4) throw new Error("viewport frame payload is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  if (4 + metaLen > bytes.byteLength) throw new Error("viewport frame meta is truncated");
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + metaLen)),
  ) as {
    width: number;
    height: number;
    backend: ViewportBackend;
    presented?: boolean;
    selectedLayerFrame?: ViewportSelectedLayerFrame | null;
    documentKey?: string | null;
    transactionId?: string | null;
    sequence?: number | null;
  };
  const presented = meta.presented === true;
  const png = bytes.subarray(4 + metaLen);
  const data_url = presented
    ? ""
    : URL.createObjectURL(new Blob([new Uint8Array(png)], { type: "image/png" }));
  return {
    data_url,
    width: meta.width,
    height: meta.height,
    backend: meta.backend,
    presented,
    selectedLayerFrame: meta.selectedLayerFrame ?? null,
    documentKey: meta.documentKey ?? null,
    transactionId: meta.transactionId ?? null,
    sequence: meta.sequence ?? null,
  };
}

export function decodePixelsPayload(payload: ArrayBuffer | Uint8Array): ViewportPixels {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.byteLength < 4) throw new Error("viewport pixels payload is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  if (4 + metaLen > bytes.byteLength) throw new Error("viewport pixels meta is truncated");
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + metaLen)),
  ) as { width: number; height: number; backend: ViewportBackend };
  const pixels = bytes.subarray(4 + metaLen);
  if (pixels.byteLength !== meta.width * meta.height * 4) {
    throw new Error(
      `viewport pixels payload is ${pixels.byteLength} bytes, expected ${meta.width * meta.height * 4}`,
    );
  }
  return { width: meta.width, height: meta.height, backend: meta.backend, pixels };
}
