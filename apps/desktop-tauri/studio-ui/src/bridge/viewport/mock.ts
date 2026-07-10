import type {
  LayeredAssetLayerRef,
  TimelineClipRef,
  ViewportBackend,
  ViewportClient,
  ViewportFrame,
  ViewportFrameExportFormat,
  ViewportFrameExportResult,
  ViewportKind,
  ViewportMaskOverlay,
  ViewportOverlayScene,
  ViewportPixels,
  ViewportPlacement,
  ViewportPlacementReport,
  ViewportTarget,
} from "./contracts";

const MOCK_FRAME_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const MOCK_BACKEND: ViewportBackend = {
  requested: "auto",
  actual: "cpu",
  fallback_reason: "browser preview mock transport",
};

interface MockViewport {
  kind: ViewportKind;
  target: ViewportTarget | null;
  width: number;
  height: number;
  gradeDoc: unknown | null;
  clipPropsDoc: string | null;
  clipPropsTimeSec: number;
  maskOverlay: ViewportMaskOverlay | null;
  overlayScene: ViewportOverlayScene | null;
  view: { zoom: number; panX: number; panY: number };
  placement: ViewportPlacement | null;
  presented: boolean;
}

function nodeOutputKey(nodeId: string, outputPort?: string): string {
  return outputPort ? `${nodeId}:${outputPort}` : nodeId;
}

function validateView(zoom: number, panX: number, panY: number): void {
  if (!(Number.isFinite(zoom) && Number.isFinite(panX) && Number.isFinite(panY)) || zoom <= 0) {
    throw new Error("view parameters must be finite with a positive zoom");
  }
}

export class MockViewportClient implements ViewportClient {
  private readonly viewports = new Map<string, MockViewport>();
  private readonly layeredAssets = new Map<string, Map<string, string>>();
  private readonly timelines = new Map<string, Map<string, TimelineClipRef>>();
  private readonly nodeOutputs = new Map<string, string>();
  private nextId = 1;

  openViewportCount(): number {
    return this.viewports.size;
  }

  viewportPresentation(viewportId: string): {
    placement: ViewportPlacement | null;
    presented: boolean;
  } {
    const viewport = this.get(viewportId);
    return { placement: viewport.placement, presented: viewport.presented };
  }

  async createViewport(kind: ViewportKind) {
    const viewport_id = `mock-vp-${this.nextId++}`;
    this.viewports.set(viewport_id, {
      kind,
      target: null,
      width: 0,
      height: 0,
      gradeDoc: null,
      clipPropsDoc: null,
      clipPropsTimeSec: 0,
      maskOverlay: null,
      overlayScene: null,
      view: { zoom: 1, panX: 0, panY: 0 },
      placement: null,
      presented: false,
    });
    console.info(`[viewport] created ${viewport_id} kind=${kind} (mock)`);
    return { viewport_id, kind, backend: MOCK_BACKEND };
  }

  async destroyViewport(viewportId: string): Promise<void> {
    this.get(viewportId);
    this.viewports.delete(viewportId);
    console.info(`[viewport] destroyed ${viewportId} (mock)`);
  }

  async setViewportTarget(viewportId: string, target: ViewportTarget): Promise<void> {
    if (target.kind === "image_layer") {
      const layers = this.layeredAssets.get(target.assetId);
      if (!layers) throw new Error(`unknown layered asset id: ${target.assetId}`);
      if (!layers.has(target.layerId)) {
        throw new Error(`unknown layer id ${target.layerId} on layered asset ${target.assetId}`);
      }
    }
    if (target.kind === "video_clip") {
      const clips = this.timelines.get(target.timelineId);
      if (!clips) throw new Error(`unknown timeline id: ${target.timelineId}`);
      if (!clips.has(target.clipId)) {
        throw new Error(`unknown clip id ${target.clipId} on timeline ${target.timelineId}`);
      }
    }
    if (
      target.kind === "node_output" &&
      !this.nodeOutputs.has(nodeOutputKey(target.nodeId, target.outputPort))
    ) {
      throw new Error(`unknown node output: ${nodeOutputKey(target.nodeId, target.outputPort)}`);
    }
    this.get(viewportId).target = target;
  }

  async registerLayeredAsset(
    assetId: string,
    layers: LayeredAssetLayerRef[],
  ): Promise<void> {
    if (!assetId) throw new Error("layered asset id must not be empty");
    if (layers.length === 0) throw new Error(`layered asset ${assetId} has no layers to register`);
    this.layeredAssets.set(assetId, new Map(layers.map((layer) => [layer.layerId, layer.rgbaPath])));
  }

  async unregisterLayeredAsset(assetId: string): Promise<void> {
    this.layeredAssets.delete(assetId);
  }

  async registerTimeline(timelineId: string, clips: TimelineClipRef[]): Promise<void> {
    if (!timelineId) throw new Error("timeline id must not be empty");
    this.timelines.set(timelineId, new Map(clips.map((clip) => [clip.clipId, clip])));
  }

  async unregisterTimeline(timelineId: string): Promise<void> {
    this.timelines.delete(timelineId);
  }

  async registerNodeOutput(nodeId: string, path: string, outputPort?: string): Promise<void> {
    if (!nodeId) throw new Error("node id must not be empty");
    if (outputPort === "") throw new Error(`node ${nodeId} has an empty output port`);
    this.nodeOutputs.set(nodeOutputKey(nodeId, outputPort), path);
  }

  async unregisterNodeOutput(nodeId: string): Promise<void> {
    for (const key of [...this.nodeOutputs.keys()]) {
      if (key === nodeId || key.startsWith(`${nodeId}:`)) this.nodeOutputs.delete(key);
    }
  }

  async resizeViewport(viewportId: string, width: number, height: number): Promise<void> {
    const viewport = this.get(viewportId);
    viewport.width = width;
    viewport.height = height;
  }

  async exportViewportFrame(
    viewportId: string,
    path: string,
    format: ViewportFrameExportFormat,
  ): Promise<ViewportFrameExportResult> {
    const viewport = this.get(viewportId);
    if (!viewport.target) throw new Error(`viewport ${viewportId} has no target`);
    return {
      path,
      width: Math.max(viewport.width, 1),
      height: Math.max(viewport.height, 1),
      format,
    };
  }

  async setViewportGrade(
    viewportId: string,
    doc: unknown | null,
    temporalDenoise = 0,
  ): Promise<void> {
    const viewport = this.get(viewportId);
    if (viewport.kind !== "grade_preview" && viewport.kind !== "video_preview") {
      throw new Error(`viewport ${viewportId} (kind=${viewport.kind}) does not accept a grade doc`);
    }
    if (!Number.isFinite(temporalDenoise) || temporalDenoise < 0 || temporalDenoise > 1) {
      throw new Error(`temporal_denoise must be between 0 and 1, got ${temporalDenoise}`);
    }
    viewport.gradeDoc = doc;
  }

  async setViewportClipProps(
    viewportId: string,
    doc: string | null,
    timeSec = 0,
  ): Promise<void> {
    const viewport = this.get(viewportId);
    if (viewport.kind !== "video_preview") {
      throw new Error(
        `viewport ${viewportId} (kind=${viewport.kind}) does not accept a clip props doc`,
      );
    }
    if (!Number.isFinite(timeSec) || timeSec < 0) {
      throw new Error(`invalid clip props time ${timeSec}`);
    }
    viewport.clipPropsDoc = doc;
    viewport.clipPropsTimeSec = timeSec;
  }

  async setViewportMaskOverlay(
    viewportId: string,
    overlay: ViewportMaskOverlay | null,
  ): Promise<void> {
    const viewport = this.get(viewportId);
    if (viewport.kind !== "image_edit") {
      throw new Error(
        `viewport ${viewportId} (kind=${viewport.kind}) does not accept a mask overlay`,
      );
    }
    if (overlay) {
      if (overlay.data.length !== overlay.w * overlay.h) {
        throw new Error(
          `mask overlay buffer is ${overlay.data.length} bytes, expected ${overlay.w * overlay.h}`,
        );
      }
      if (!Number.isFinite(overlay.alpha) || overlay.alpha < 0 || overlay.alpha > 1) {
        throw new Error(`mask overlay alpha must be between 0 and 1, got ${overlay.alpha}`);
      }
    }
    viewport.maskOverlay = overlay;
  }

  async setViewportOverlayScene(
    viewportId: string,
    scene: ViewportOverlayScene | null,
  ): Promise<void> {
    const viewport = this.get(viewportId);
    if (viewport.kind !== "image_edit" && viewport.kind !== "video_preview") {
      throw new Error(
        `viewport ${viewportId} (kind=${viewport.kind}) does not accept an overlay scene`,
      );
    }
    if (scene) {
      for (const item of scene.items) {
        const coordinates =
          item.kind === "marquee"
            ? item.region
            : item.kind === "marker"
              ? [...item.center, item.size]
              : item.kind === "band"
                ? [...item.points.flat(), item.radius]
                : item.points.flat();
        if (coordinates.some((value) => !Number.isFinite(value))) {
          throw new Error("overlay scene coordinates must be finite");
        }
        if (item.kind === "band" && !(item.radius >= 0 && item.radius <= 1)) {
          throw new Error(`overlay band radius must be between 0 and 1, got ${item.radius}`);
        }
        if (item.kind !== "marquee") {
          const colours =
            item.kind === "band"
              ? item.color
              : [...item.stroke, ...(item.kind !== "polyline" ? (item.fill ?? []) : [])];
          if (colours.some((value) => !(value >= 0 && value <= 1))) {
            throw new Error("overlay colours must be between 0 and 1");
          }
        }
      }
    }
    viewport.overlayScene = scene;
  }

  async setViewportView(
    viewportId: string,
    zoom: number,
    panX: number,
    panY: number,
  ): Promise<void> {
    validateView(zoom, panX, panY);
    this.get(viewportId).view = { zoom, panX, panY };
  }

  async presentViewportView(
    viewportId: string,
    zoom: number,
    panX: number,
    panY: number,
  ): Promise<boolean> {
    validateView(zoom, panX, panY);
    this.get(viewportId).view = { zoom, panX, panY };
    return false;
  }

  async renderViewportFrame(viewportId: string): Promise<ViewportFrame> {
    const viewport = this.get(viewportId);
    if (!viewport.target) throw new Error(`viewport ${viewportId} has no target`);
    const zoom = Math.max(viewport.view.zoom, 1);
    return {
      data_url: MOCK_FRAME_PNG,
      width: Math.max(Math.round(viewport.width / zoom), 1),
      height: Math.max(Math.round(viewport.height / zoom), 1),
      backend: MOCK_BACKEND,
      presented: false,
    };
  }

  async readViewportPixels(viewportId: string): Promise<ViewportPixels> {
    const viewport = this.get(viewportId);
    const width = Math.max(viewport.width, 1);
    const height = Math.max(viewport.height, 1);
    return {
      width,
      height,
      backend: MOCK_BACKEND,
      pixels: new Uint8Array(width * height * 4),
    };
  }

  async setViewportPlacement(
    viewportId: string,
    placement: ViewportPlacement,
  ): Promise<ViewportPlacementReport> {
    const values = [placement.x, placement.y, placement.width, placement.height, placement.dpr];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error("placement values must be finite");
    }
    if (placement.width < 0 || placement.height < 0) {
      throw new Error(
        `placement size must not be negative: ${placement.width}x${placement.height}`,
      );
    }
    this.get(viewportId).placement = placement;
    return { presented: false, fallback_reason: "browser preview mock transport" };
  }

  async setViewportPresented(viewportId: string, presented: boolean): Promise<void> {
    this.get(viewportId).presented = presented;
  }

  private get(viewportId: string): MockViewport {
    const viewport = this.viewports.get(viewportId);
    if (!viewport) throw new Error(`unknown viewport id: ${viewportId}`);
    return viewport;
  }
}

export function createMockViewportClient(): MockViewportClient {
  return new MockViewportClient();
}
