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
  /** Human-readable device detail (adapter name + backend) when known. */
  detail?: string;
  fallback_reason?: string;
}

export interface ViewportDescriptor {
  viewport_id: string;
  kind: ViewportKind;
  backend: ViewportBackend;
}

export interface ViewportFrame {
  /** Presentable image source. On desktop this is a `blob:` object URL over
   * the binary frame payload (the caller owns revocation); in the browser
   * preview it is a data URL. Empty when `presented` is true — the frame is
   * already on the native surface and no pixels crossed the IPC boundary. */
  data_url: string;
  width: number;
  height: number;
  backend: ViewportBackend;
  /** The frame presented on the viewport's native surface window (WGPU
   * surface swap Phase S2): presenters clear their `<img>` and let the
   * surface show through instead of mounting `data_url`. */
  presented: boolean;
}

/** Binary frame payload layout (see `viewport_render_frame_bin`):
 * `[u32 LE meta length][meta JSON {width, height, backend, presented}][PNG
 * bytes]`; a presented frame carries no PNG bytes. Exported for tests;
 * product code receives decoded frames from `renderViewportFrame`. */
export function decodeFramePayload(payload: ArrayBuffer | Uint8Array): ViewportFrame {
  const bytes =
    payload instanceof Uint8Array
      ? payload
      : new Uint8Array(payload);
  if (bytes.byteLength < 4) throw new Error("viewport frame payload is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  if (4 + metaLen > bytes.byteLength) throw new Error("viewport frame meta is truncated");
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + metaLen)),
  ) as { width: number; height: number; backend: ViewportBackend; presented?: boolean };
  const presented = meta.presented === true;
  const png = bytes.subarray(4 + metaLen);
  const data_url = presented
    ? ""
    : URL.createObjectURL(new Blob([new Uint8Array(png)], { type: "image/png" }));
  return { data_url, width: meta.width, height: meta.height, backend: meta.backend, presented };
}

/** Decoded `viewport_read_pixels` payload: raw RGBA8 rows, never encoded. */
export interface ViewportPixels {
  width: number;
  height: number;
  backend: ViewportBackend;
  /** Row-major `width * height * 4` RGBA bytes. */
  pixels: Uint8Array;
}

/** Binary pixels payload layout (see `viewport_read_pixels`):
 * `[u32 LE meta length][meta JSON {width, height, backend}][raw RGBA8 rows]`.
 * Exported for tests; product code calls `readViewportPixels`. */
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
  maskOverlay: ViewportMaskOverlay | null;
  overlayScene: ViewportOverlayScene | null;
  view: { zoom: number; panX: number; panY: number };
  placement: ViewportPlacement | null;
  presented: boolean;
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
    maskOverlay: null,
    overlayScene: null,
    view: { zoom: 1, panX: 0, panY: 0 },
    placement: null,
    presented: false,
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

/**
 * Drop a layered asset's host-side registration (the asset was deleted).
 * Unknown ids are a no-op so deletion cascades never fail.
 */
export async function unregisterLayeredAsset(assetId: string): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_unregister_layered_asset", { assetId });
    return;
  }
  mockLayeredAssets.delete(assetId);
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
 * Drop a timeline's host-side registration (its presenter closed). Unknown
 * ids are a no-op so cascades never fail.
 */
export async function unregisterTimeline(timelineId: string): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_unregister_timeline", { timelineId });
    return;
  }
  mockTimelines.delete(timelineId);
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

/**
 * Drop every output registration of a node — any port — with the viewport
 * host (the node was deleted). Unknown ids are a no-op so deletion cascades
 * never fail.
 */
export async function unregisterNodeOutput(nodeId: string): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_unregister_node_output", { nodeId });
    return;
  }
  for (const key of [...mockNodeOutputs.keys()]) {
    if (key === nodeId || key.startsWith(`${nodeId}:`)) mockNodeOutputs.delete(key);
  }
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

/**
 * Set (or clear) the grade doc the viewport applies at render time.
 * `temporalDenoise` (`0..=1`, video targets only) blends each graded frame
 * against the previous graded frame during continuous playback; `0` / absent
 * disables it.
 */
export async function setViewportGrade(
  viewportId: string,
  doc: unknown | null,
  temporalDenoise = 0,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_set_grade", { viewportId, doc, temporalDenoise });
    return;
  }
  const vp = mockGet(viewportId);
  if (vp.kind !== "grade_preview" && vp.kind !== "video_preview") {
    throw new Error(`viewport ${viewportId} (kind=${vp.kind}) does not accept a grade doc`);
  }
  if (!Number.isFinite(temporalDenoise) || temporalDenoise < 0 || temporalDenoise > 1) {
    throw new Error(`temporal_denoise must be between 0 and 1, got ${temporalDenoise}`);
  }
  vp.gradeDoc = doc;
}

/** A working-scale mask the host tints over rendered frames (image_edit
 * viewports): the mask editor's morphology preview or quick-mask ruby. The
 * buffer covers the full document at proxy resolution; the host samples it at
 * the view window so the tint follows zoom. */
export interface ViewportMaskOverlay {
  w: number;
  h: number;
  /** Row-major `w * h` coverage bytes (0..255). */
  data: Uint8Array;
  /** Tint colour (sRGB). */
  rgb: [number, number, number];
  /** Peak overlay opacity (0..=1) at full coverage. */
  alpha: number;
  /** Tint where coverage is low (quick mask: unselected area reads ruby). */
  invert?: boolean;
}

/** Standard base64 of a byte buffer (chunked so large buffers don't overflow
 * the argument list). */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Set (or clear) the mask overlay an image-edit viewport composites over
 * rendered frames — the selection tint presents host-side at the view
 * window's detail instead of an upscaled document-size canvas overlay.
 */
export async function setViewportMaskOverlay(
  viewportId: string,
  overlay: ViewportMaskOverlay | null,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_set_mask_overlay", {
      viewportId,
      overlay: overlay
        ? {
            w: overlay.w,
            h: overlay.h,
            data: base64Encode(overlay.data),
            rgb: overlay.rgb,
            alpha: overlay.alpha,
            invert: overlay.invert ?? false,
          }
        : null,
    });
    return;
  }
  const vp = mockGet(viewportId);
  if (vp.kind !== "image_edit") {
    throw new Error(`viewport ${viewportId} (kind=${vp.kind}) does not accept a mask overlay`);
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
  vp.maskOverlay = overlay;
}

/** One primitive of a vector overlay scene, in normalized document
 * coordinates (0..=1 over the full document, view-independent). */
export type ViewportOverlayItem =
  | {
      kind: "marquee";
      /** `[x1, y1, x2, y2]` corners, normalized. */
      region: [number, number, number, number];
      ellipse?: boolean;
    }
  | {
      kind: "polygon";
      /** `[x, y]` vertices, normalized; the loop closes implicitly.
       * Beziers are flattened to straight segments by the sender. */
      points: [number, number][];
      /** Outline colour `[r, g, b, a]` in 0..=1. */
      stroke: [number, number, number, number];
      /** Even-odd interior fill colour, when the shape reads as a region. */
      fill?: [number, number, number, number];
      /** Dash the outline (6-on/4-off) instead of a solid stroke. */
      dash?: boolean;
    }
  | {
      kind: "polyline";
      /** `[x, y]` vertices, normalized; the loop does not close. */
      points: [number, number][];
      /** Stroke colour `[r, g, b, a]` in 0..=1. */
      stroke: [number, number, number, number];
      dash?: boolean;
    }
  | {
      kind: "band";
      /** `[x, y]` centreline vertices, normalized; a single point is a dot. */
      points: [number, number][];
      /** Band radius as a fraction of the document width. */
      radius: number;
      /** Band colour `[r, g, b, a]` in 0..=1, blended once over the band. */
      color: [number, number, number, number];
    }
  | {
      kind: "marker";
      /** `[x, y]` anchor, normalized. */
      center: [number, number];
      /** Fixed screen-size glyph anchored to the document point. */
      shape: "disc" | "cross" | "minus";
      /** Radius / half-extent in surface pixels. */
      size: number;
      stroke: [number, number, number, number];
      fill?: [number, number, number, number];
    };

/** A vector overlay the host strokes over rendered frames (image_edit and
 * video_preview viewports): the mask editor's marquee marching ants, the
 * program monitor's safe-area guides — drawn host-side at the view window's
 * detail instead of on a document-size canvas. */
export interface ViewportOverlayScene {
  items: ViewportOverlayItem[];
}

/**
 * Set (or clear) the vector overlay an image-edit or video-preview viewport
 * strokes over rendered frames — selection outlines and safe-area guides
 * present host-side at the view window's detail, one screen pixel wide at
 * any zoom.
 */
export async function setViewportOverlayScene(
  viewportId: string,
  scene: ViewportOverlayScene | null,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_set_overlay_scene", { viewportId, scene });
    return;
  }
  const vp = mockGet(viewportId);
  if (vp.kind !== "image_edit" && vp.kind !== "video_preview") {
    throw new Error(`viewport ${viewportId} (kind=${vp.kind}) does not accept an overlay scene`);
  }
  if (scene) {
    for (const item of scene.items) {
      const coords =
        item.kind === "marquee"
          ? item.region
          : item.kind === "marker"
            ? [...item.center, item.size]
            : item.kind === "band"
              ? [...item.points.flat(), item.radius]
              : item.points.flat();
      if (coords.some((v) => !Number.isFinite(v))) {
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
        if (colours.some((v) => !(v >= 0 && v <= 1))) {
          throw new Error("overlay colours must be between 0 and 1");
        }
      }
    }
  }
  vp.overlayScene = scene;
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

/**
 * The zoom/pan fast path (surface swap): set the view and re-present the
 * native surface's cached frame texture cropped to it — a pure GPU pass with
 * no render and no pixel transport. Resolves `false` when no presented
 * texture exists to crop (browser preview, surface hidden, no frame yet):
 * the caller keeps riding its CSS transform until the settle render.
 */
export async function presentViewportView(
  viewportId: string,
  zoom: number,
  panX: number,
  panY: number,
): Promise<boolean> {
  const invoke = tauriInvoke();
  if (invoke) {
    return (await invoke("viewport_present_view", { viewportId, zoom, panX, panY })) as boolean;
  }
  if (!(Number.isFinite(zoom) && Number.isFinite(panX) && Number.isFinite(panY)) || zoom <= 0) {
    throw new Error("view parameters must be finite with a positive zoom");
  }
  mockGet(viewportId).view = { zoom, panX, panY };
  return false;
}

export async function renderViewportFrame(viewportId: string): Promise<ViewportFrame> {
  const invoke = tauriInvoke();
  if (invoke) {
    const payload = (await invoke("viewport_render_frame_bin", { viewportId })) as
      | ArrayBuffer
      | Uint8Array;
    return decodeFramePayload(payload);
  }
  const vp = mockGet(viewportId);
  if (!vp.target) throw new Error(`viewport ${viewportId} has no target`);
  // Like the desktop transport, a zoomed view renders the `1/zoom` window.
  const zoom = Math.max(vp.view.zoom, 1);
  return {
    data_url: MOCK_FRAME_PNG,
    width: Math.max(Math.round(vp.width / zoom), 1),
    height: Math.max(Math.round(vp.height / zoom), 1),
    backend: MOCK_BACKEND,
    presented: false,
  };
}

/**
 * Explicit pixel readback for the cases that genuinely need bytes in the
 * webview — export preview, scopes, colour picking — never the per-frame
 * path (WGPU surface swap Phase S4). In the browser preview the mock answers
 * a transparent buffer at the viewport's size.
 */
export async function readViewportPixels(viewportId: string): Promise<ViewportPixels> {
  const invoke = tauriInvoke();
  if (invoke) {
    const payload = (await invoke("viewport_read_pixels", { viewportId })) as
      | ArrayBuffer
      | Uint8Array;
    return decodePixelsPayload(payload);
  }
  const vp = mockGet(viewportId);
  const width = Math.max(vp.width, 1);
  const height = Math.max(vp.height, 1);
  return {
    width,
    height,
    backend: MOCK_BACKEND,
    pixels: new Uint8Array(width * height * 4),
  };
}

/** Placement of a viewport's element rect, in logical CSS pixels relative to
 * the webview's client origin, plus the device pixel ratio the host uses to
 * convert to device pixels (WGPU surface swap Phase S1). */
export interface ViewportPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
}

/** Host report from `setViewportPlacement`: whether the native surface path
 * took the placement. `presented: false` + a reason means the PNG transport
 * stays authoritative (fallback contract — a decision, not a failure). */
export interface ViewportPlacementReport {
  presented: boolean;
  fallback_reason?: string;
}

/**
 * Report the viewport element's rect so the host can position its native
 * surface window under it. On desktop the child window is created lazily on
 * the first placement; in the browser preview (and on hosts without the
 * surface path) this is a recorded no-op reporting fallback.
 */
export async function setViewportPlacement(
  viewportId: string,
  placement: ViewportPlacement,
): Promise<ViewportPlacementReport> {
  const invoke = tauriInvoke();
  if (invoke) {
    return (await invoke("viewport_set_placement", {
      viewportId,
      ...placement,
    })) as ViewportPlacementReport;
  }
  const values = [placement.x, placement.y, placement.width, placement.height, placement.dpr];
  if (values.some((v) => !Number.isFinite(v))) {
    throw new Error("placement values must be finite");
  }
  if (placement.width < 0 || placement.height < 0) {
    throw new Error(`placement size must not be negative: ${placement.width}x${placement.height}`);
  }
  mockGet(viewportId).placement = placement;
  return { presented: false, fallback_reason: "browser preview mock transport" };
}

/**
 * Show/hide the viewport's native surface window without destroying it
 * (occlusion: modals over the hole, hidden panels). A recorded no-op in the
 * browser preview.
 */
export async function setViewportPresented(
  viewportId: string,
  presented: boolean,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("viewport_set_presented", { viewportId, presented });
    return;
  }
  mockGet(viewportId).presented = presented;
}

/** Test-only: how many mock viewports are currently open. */
export function openMockViewportCount(): number {
  return mockViewports.size;
}

/** Test-only: the mock viewport's last recorded placement/presented state. */
export function mockViewportPresentation(viewportId: string): {
  placement: ViewportPlacement | null;
  presented: boolean;
} {
  const vp = mockGet(viewportId);
  return { placement: vp.placement, presented: vp.presented };
}
