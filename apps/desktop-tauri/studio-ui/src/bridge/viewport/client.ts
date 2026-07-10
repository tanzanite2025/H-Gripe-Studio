import { tauriInvoke, type Invoke } from "../core";
import {
  decodeFramePayload,
  decodePixelsPayload,
  type ViewportClient,
  type ViewportDescriptor,
  type ViewportFrameExportResult,
  type ViewportPlacementReport,
} from "./contracts";
import { createMockViewportClient } from "./mock";

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createTauriViewportClient(invoke: Invoke): ViewportClient {
  return {
    async createViewport(kind) {
      return (await invoke("viewport_create", { kind })) as ViewportDescriptor;
    },
    async destroyViewport(viewportId) {
      await invoke("viewport_destroy", { viewportId });
    },
    async setViewportTarget(viewportId, target) {
      await invoke("viewport_set_target", { viewportId, target });
    },
    async registerLayeredAsset(assetId, layers) {
      await invoke("viewport_register_layered_asset", { assetId, layers });
    },
    async unregisterLayeredAsset(assetId) {
      await invoke("viewport_unregister_layered_asset", { assetId });
    },
    async registerTimeline(timelineId, clips) {
      await invoke("viewport_register_timeline", { timelineId, clips });
    },
    async unregisterTimeline(timelineId) {
      await invoke("viewport_unregister_timeline", { timelineId });
    },
    async registerNodeOutput(nodeId, path, outputPort) {
      await invoke("viewport_register_node_output", {
        nodeId,
        outputPort: outputPort ?? null,
        path,
      });
    },
    async unregisterNodeOutput(nodeId) {
      await invoke("viewport_unregister_node_output", { nodeId });
    },
    async resizeViewport(viewportId, width, height) {
      await invoke("viewport_resize", { viewportId, width, height });
    },
    async exportViewportFrame(viewportId, path, format) {
      return (await invoke("viewport_export_frame", {
        viewportId,
        path,
        format,
      })) as ViewportFrameExportResult;
    },
    async setViewportGrade(viewportId, doc, temporalDenoise = 0) {
      await invoke("viewport_set_grade", { viewportId, doc, temporalDenoise });
    },
    async setViewportClipProps(viewportId, doc, timeSec = 0) {
      await invoke("viewport_set_clip_props", { viewportId, doc, timeSec });
    },
    async setViewportMaskOverlay(viewportId, overlay) {
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
    },
    async setViewportOverlayScene(viewportId, scene) {
      await invoke("viewport_set_overlay_scene", { viewportId, scene });
    },
    async setViewportView(viewportId, zoom, panX, panY) {
      await invoke("viewport_set_view", { viewportId, zoom, panX, panY });
    },
    async presentViewportView(viewportId, zoom, panX, panY) {
      return (await invoke("viewport_present_view", {
        viewportId,
        zoom,
        panX,
        panY,
      })) as boolean;
    },
    async renderViewportFrame(viewportId) {
      const payload = (await invoke("viewport_render_frame_bin", { viewportId })) as
        | ArrayBuffer
        | Uint8Array;
      return decodeFramePayload(payload);
    },
    async readViewportPixels(viewportId) {
      const payload = (await invoke("viewport_read_pixels", { viewportId })) as
        | ArrayBuffer
        | Uint8Array;
      return decodePixelsPayload(payload);
    },
    async setViewportPlacement(viewportId, placement) {
      return (await invoke("viewport_set_placement", {
        viewportId,
        ...placement,
      })) as ViewportPlacementReport;
    },
    async setViewportPresented(viewportId, presented) {
      await invoke("viewport_set_presented", { viewportId, presented });
    },
  };
}

let injectedClient: ViewportClient | null = null;
let browserClient: ViewportClient | null = null;
let tauriClient: { invoke: Invoke; client: ViewportClient } | null = null;

export function viewportClient(): ViewportClient {
  if (injectedClient) return injectedClient;
  const invoke = tauriInvoke();
  if (invoke) {
    if (!tauriClient || tauriClient.invoke !== invoke) {
      tauriClient = { invoke, client: createTauriViewportClient(invoke) };
    }
    return tauriClient.client;
  }
  browserClient ??= createMockViewportClient();
  return browserClient;
}

export function setViewportClientForTesting(client: ViewportClient | null): void {
  injectedClient = client;
}
