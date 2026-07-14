import { describe, expect, it, vi } from "vitest";

import type { Invoke } from "../core";
import { createTauriViewportClient } from "./client";
import type { ViewportBackend } from "./contracts";

const BACKEND: ViewportBackend = { requested: "auto", actual: "cpu" };

function payload(meta: unknown, bytes: Uint8Array): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const output = new Uint8Array(4 + metaBytes.length + bytes.length);
  new DataView(output.buffer).setUint32(0, metaBytes.length, true);
  output.set(metaBytes, 4);
  output.set(bytes, 4 + metaBytes.length);
  return output;
}

describe("createTauriViewportClient", () => {
  it("maps viewport operations to their Tauri command contracts", async () => {
    const invoke = vi.fn<Invoke>(async (command) => {
      if (command === "viewport_create") {
        return { viewport_id: "vp-1", kind: "image_edit", backend: BACKEND };
      }
      if (command === "viewport_present_view") return true;
      return null;
    });
    const client = createTauriViewportClient(invoke);

    await expect(client.createViewport("image_edit")).resolves.toMatchObject({
      viewport_id: "vp-1",
      kind: "image_edit",
    });
    await client.registerNodeOutput("node-1", "/tmp/out.png");
    await client.setViewportMaskOverlay("vp-1", {
      w: 2,
      h: 1,
      data: new Uint8Array([1, 2]),
      rgb: [86, 168, 255],
      alpha: 0.55,
    });
    await expect(client.presentViewportView("vp-1", 2, 0.25, 0.25)).resolves.toBe(true);
    const presentation = {
      selectedLayerId: "layer-1",
      transactionId: "move-1",
      baseDocumentKey: "doc-1",
      sequence: 0,
      moveDraft: null,
    };
    const scene = {
      document: { layers: [] },
      documentKey: "doc-1",
      documentWidth: 640,
      documentHeight: 480,
      frameX: 0,
      frameY: 0,
      frameWidth: 640,
      frameHeight: 480,
    };
    await client.setViewportImageScene("vp-1", scene);
    await client.presentImageLayerScene("vp-1", presentation);

    expect(invoke).toHaveBeenCalledWith("viewport_register_node_output", {
      nodeId: "node-1",
      outputPort: null,
      path: "/tmp/out.png",
    });
    expect(invoke).toHaveBeenCalledWith("viewport_set_mask_overlay", {
      viewportId: "vp-1",
      overlay: {
        w: 2,
        h: 1,
        data: "AQI=",
        rgb: [86, 168, 255],
        alpha: 0.55,
        invert: false,
      },
    });
    expect(invoke).toHaveBeenCalledWith("viewport_present_image_layer_scene", {
      viewportId: "vp-1",
      presentation,
    });
    expect(invoke).toHaveBeenCalledWith("viewport_set_image_scene", {
      viewportId: "vp-1",
      scene,
    });
  });

  it("decodes binary frame and pixel responses", async () => {
    const invoke = vi.fn<Invoke>(async (command) => {
      if (command === "viewport_render_frame_bin") {
        return payload(
          {
            width: 640,
            height: 360,
            backend: BACKEND,
            presented: true,
            selectedLayerFrame: {
              owner: "selected-layer-frame",
              shape: "axis-aligned-rect",
              layerId: "layer-1",
              rect: [10, 20, 110, 120],
              sourceRect: [0, 0, 100, 100],
              source: "asset-frame",
            },
            documentKey: "doc-1",
            transactionId: "move-1",
            sequence: 3,
          },
          new Uint8Array(),
        );
      }
      if (command === "viewport_read_pixels") {
        return payload({ width: 1, height: 1, backend: BACKEND }, new Uint8Array([1, 2, 3, 4]));
      }
      return null;
    });
    const client = createTauriViewportClient(invoke);

    await expect(client.renderViewportFrame("vp-1")).resolves.toMatchObject({
      width: 640,
      height: 360,
      data_url: "",
      presented: true,
      selectedLayerFrame: expect.objectContaining({
        layerId: "layer-1",
        rect: [10, 20, 110, 120],
      }),
      documentKey: "doc-1",
      transactionId: "move-1",
      sequence: 3,
    });
    await expect(client.readViewportPixels("vp-1")).resolves.toMatchObject({
      width: 1,
      height: 1,
      pixels: new Uint8Array([1, 2, 3, 4]),
    });
  });
});
