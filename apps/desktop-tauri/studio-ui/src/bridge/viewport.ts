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
  | { kind: "node_output"; nodeId: string; outputPort?: string };

/** Fallback contract: fallback is a reportable runtime decision, not failure. */
export interface ViewportBackend {
  requested: "auto" | "gpu" | "cpu";
  actual: "wgpu" | "cpu";
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
}

const mockViewports = new Map<string, MockViewport>();
let mockNextId = 1;

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
  mockViewports.set(viewport_id, { kind, target: null, width: 0, height: 0 });
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
  mockGet(viewportId).target = target;
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

export async function renderViewportFrame(viewportId: string): Promise<ViewportFrame> {
  const invoke = tauriInvoke();
  if (invoke) return (await invoke("viewport_render_frame", { viewportId })) as ViewportFrame;
  const vp = mockGet(viewportId);
  if (!vp.target) throw new Error(`viewport ${viewportId} has no target`);
  return {
    data_url: MOCK_FRAME_PNG,
    width: Math.max(vp.width, 1),
    height: Math.max(vp.height, 1),
    backend: MOCK_BACKEND,
  };
}

/** Test-only: how many mock viewports are currently open. */
export function openMockViewportCount(): number {
  return mockViewports.size;
}
