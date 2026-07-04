// Viewport host transport (WGPU migration Phase 1). The product layer never
// talks to raw texture code: it opens a viewport, points it at a reference
// target, asks for frames, and destroys it. On desktop these map to the
// `viewport_*` Tauri commands; in a plain browser preview a mocked in-memory
// transport keeps the host usable for UI development.

import { tauriInvoke } from "./core";

export type ViewportKind = "image_edit" | "grade_preview" | "video_preview";

/** Lightweight reference targets — ids only, never pixels. */
export type ViewportTarget =
  | { kind: "image"; resourceId: string }
  | { kind: "image_layer"; assetId: string; layerId: string }
  | { kind: "video_clip"; timelineId: string; clipId: string; timeSec: number }
  | { kind: "video_frame"; resourceId: string; timeSec: number }
  | { kind: "node_output"; nodeId: string; outputPort?: string };

/** Fallback contract: fallback is a reportable runtime decision, not failure. */
export interface ViewportBackend {
  requested: "auto" | "gpu" | "cpu";
  actual: "wgpu" | "gpu" | "cpu";
  fallback_reason?: string;
}

export interface ViewportDescriptor {
  viewport_id: string;
  kind: ViewportKind;
  backend: ViewportBackend;
}

export interface ViewportFrame {
  data_url: string;
  width: number;
  height: number;
  backend: ViewportBackend;
}

// --- browser-preview mock transport -----------------------------------------

// 1x1 transparent PNG; the mock's stand-in for a rendered frame.
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
  view: { zoom: number; panX: number; panY: number };
}

const mockViewports = new Map<string, MockViewport>();
let mockNextId = 1;

/** Mock registry of layered assets: asset id -> (layer id -> rgba path). */
const mockLayeredAssets = new Map<string, Map<string, string>>();

/** Mock registry of timelines: timeline id -> (clip id -> clip). */
const mockTimelines = new Map<string, Map<string, TimelineClipRef>>();

/** Mock registry of node outputs: "nodeId" or "nodeId:port" -> artifact path. */
const mockNodeOutputs = new Map<string, string>();

function nodeOutputKey(nodeId: string, outputPort?: string): string {
  return outputPort ? `${nodeId}:${outputPort}` : nodeId;
}

function mockGet(viewportId: string): MockViewport {
  const vp = mockViewports.get(viewportId);
  if (!vp) throw new Error(`unknown viewport id: ${viewportId}`);
  return vp;
}

// --- host transport ----------------------------------------------------------

export async function createViewport(kind: ViewportKind): Promise<ViewportDescriptor> {
  const invoke = tauriInvoke();
  if (invoke) return (await invoke("viewport_create", { kind })) as ViewportDescriptor;
  const viewport_id = `mock-vp-${mockNextId++}`;
  mockViewports.set(viewport_id, {
    kind,
    target: null,
    width: 0,
    height: 0,
    gradeDoc: null,
    view: { zoom: 1, panX: 0, panY: 0 },
  });
  console.info(`[viewport] created ${viewport_id} kind=${kind} (mock)`);
  return { viewport_id, kind, backend: MOCK_BACKEND };
}

export async function destroyViewport(viewportId: string): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_destroy", { viewportId });
    return;
  }
  mockGet(viewportId);
  mockViewports.delete(viewportId);
  console.info(`[viewport] destroyed ${viewportId} (mock)`);
}

export async function setViewportTarget(
  viewportId: string,
  target: ViewportTarget,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_set_target", { viewportId, target });
    return;
  }
  // Like the desktop host, image_layer targets must reference a registered
  // layered asset so a bad id fails at set time, not at the first render.
  if (target.kind === "image_layer") {
    const layers = mockLayeredAssets.get(target.assetId);
    if (!layers) throw new Error(`unknown layered asset id: ${target.assetId}`);
    if (!layers.has(target.layerId)) {
      throw new Error(`unknown layer id ${target.layerId} on layered asset ${target.assetId}`);
    }
  }
  // video_clip targets must reference a registered timeline's clip.
  if (target.kind === "video_clip") {
    const clips = mockTimelines.get(target.timelineId);
    if (!clips) throw new Error(`unknown timeline id: ${target.timelineId}`);
    if (!clips.has(target.clipId)) {
      throw new Error(`unknown clip id ${target.clipId} on timeline ${target.timelineId}`);
    }
  }
  // node_output targets must reference a registered node output.
  if (target.kind === "node_output") {
    if (!mockNodeOutputs.has(nodeOutputKey(target.nodeId, target.outputPort))) {
      throw new Error(`unknown node output: ${nodeOutputKey(target.nodeId, target.outputPort)}`);
    }
  }
  mockGet(viewportId).target = target;
}

/** One layer artifact of a layered asset, registered by path — never pixels. */
export interface LayeredAssetLayerRef {
  layerId: string;
  rgbaPath: string;
}

/**
 * Register (or refresh) a layered asset's layer artifacts with the viewport
 * host so `image_layer` targets resolve host-side, by reference. A
 * re-registration after an edit replaces the asset's layer set.
 */
export async function registerLayeredAsset(
  assetId: string,
  layers: LayeredAssetLayerRef[],
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_register_layered_asset", { assetId, layers });
    return;
  }
  if (!assetId) throw new Error("layered asset id must not be empty");
  if (layers.length === 0) throw new Error(`layered asset ${assetId} has no layers to register`);
  mockLayeredAssets.set(assetId, new Map(layers.map((l) => [l.layerId, l.rgbaPath])));
}

/** One timeline clip, registered by media path plus its placement. */
export interface TimelineClipRef {
  clipId: string;
  /** "video" decodes the frame at source time; "still" renders the image. */
  kind: "video" | "still";
  path: string;
  startSec: number;
  durationSec: number;
}

/**
 * Register (or refresh) a timeline's clips with the viewport host so
 * `video_clip` targets resolve host-side, by reference — the host maps the
 * timeline playhead to clip-local source time. A re-registration after an
 * edit replaces the timeline's clip set.
 */
export async function registerTimeline(
  timelineId: string,
  clips: TimelineClipRef[],
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_register_timeline", { timelineId, clips });
    return;
  }
  if (!timelineId) throw new Error("timeline id must not be empty");
  mockTimelines.set(timelineId, new Map(clips.map((c) => [c.clipId, c])));
}

/**
 * Register (or refresh) one node output's image artifact with the viewport
 * host so `node_output` targets resolve host-side, by reference. A
 * re-registration after a re-run replaces the artifact path.
 */
export async function registerNodeOutput(
  nodeId: string,
  path: string,
  outputPort?: string,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_register_node_output", { nodeId, outputPort: outputPort ?? null, path });
    return;
  }
  if (!nodeId) throw new Error("node id must not be empty");
  if (outputPort === "") throw new Error(`node ${nodeId} has an empty output port`);
  mockNodeOutputs.set(nodeOutputKey(nodeId, outputPort), path);
}

export async function resizeViewport(
  viewportId: string,
  width: number,
  height: number,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_resize", { viewportId, width, height });
    return;
  }
  const vp = mockGet(viewportId);
  vp.width = width;
  vp.height = height;
}

export async function setViewportGrade(viewportId: string, doc: unknown | null): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_set_grade", { viewportId, doc });
    return;
  }
  const vp = mockGet(viewportId);
  if (vp.kind !== "grade_preview" && vp.kind !== "video_preview") {
    throw new Error(`viewport ${viewportId} (kind=${vp.kind}) does not accept a grade doc`);
  }
  vp.gradeDoc = doc;
}

/**
 * Set the viewport's presentation view. `zoom >= 1` selects a window `1/zoom`
 * the size of the source; `panX`/`panY` place its top-left corner in
 * normalized source coordinates (clamped inside the frame). Zoom 1 with zero
 * pan is the identity view (the whole source).
 */
export async function setViewportView(
  viewportId: string,
  zoom: number,
  panX: number,
  panY: number,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_set_view", { viewportId, zoom, panX, panY });
    return;
  }
  if (!(Number.isFinite(zoom) && Number.isFinite(panX) && Number.isFinite(panY)) || zoom <= 0) {
    throw new Error("view parameters must be finite with a positive zoom");
  }
  mockGet(viewportId).view = { zoom, panX, panY };
}

export async function renderViewportFrame(viewportId: string): Promise<ViewportFrame> {
  const invoke = tauriInvoke();
  if (invoke) return (await invoke("viewport_render_frame", { viewportId })) as ViewportFrame;
  const vp = mockGet(viewportId);
  if (!vp.target) throw new Error(`viewport ${viewportId} has no target`);
  // Like the desktop transport, a zoomed view renders the `1/zoom` window.
  const zoom = Math.max(vp.view.zoom, 1);
  return {
    data_url: MOCK_FRAME_PNG,
    width: Math.max(Math.round(vp.width / zoom), 1),
    height: Math.max(Math.round(vp.height / zoom), 1),
    backend: MOCK_BACKEND,
  };
}

/** Test-only: how many mock viewports are currently open. */
export function openMockViewportCount(): number {
  return mockViewports.size;
}
