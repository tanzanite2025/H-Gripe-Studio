import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyImageEditorDocument } from "../contracts/imageEditorDocument";
import type { Invoke } from "../bridge/core";
import { canResolveSelectedLayerFrame, resolveSelectedLayerFrame } from "./selectedLayerFrame";

describe("resolveSelectedLayerFrame bridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Rust selected-layer-frame command", async () => {
    const invoke = vi.fn<Invoke>(async () => ({
      owner: "selected-layer-frame",
      shape: "axis-aligned-rect",
      layerId: "layer-1",
      rect: [1, 2, 3, 4],
      sourceRect: [1, 2, 3, 4],
      source: "asset-frame",
    }));
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    const document = emptyImageEditorDocument();

    await expect(resolveSelectedLayerFrame({
      document,
      selectedLayerId: "layer-1",
      documentWidth: 100,
      documentHeight: 80,
    })).resolves.toMatchObject({ layerId: "layer-1", rect: [1, 2, 3, 4] });

    expect(invoke).toHaveBeenCalledWith("resolve_selected_layer_frame", {
      document,
      selectedLayerId: "layer-1",
      documentWidth: 100,
      documentHeight: 80,
    });
  });

  it("rejects without a Rust/Tauri backend", async () => {
    vi.stubGlobal("window", {});

    await expect(resolveSelectedLayerFrame({
      document: emptyImageEditorDocument(),
      selectedLayerId: "layer-1",
      documentWidth: 100,
      documentHeight: 80,
    })).rejects.toThrow("Rust/Tauri backend");
  });

  it("waits for selected layer geometry before resolving", () => {
    const ready = {
      workspace: "image" as const,
      selectedLayerId: "layer-1",
      baseNeedsExplicitSource: false,
      documentWidth: 100,
      documentHeight: 80,
    };

    expect(canResolveSelectedLayerFrame(ready)).toBe(true);
    expect(canResolveSelectedLayerFrame({ ...ready, baseNeedsExplicitSource: true })).toBe(false);
    expect(canResolveSelectedLayerFrame({ ...ready, documentWidth: 1 })).toBe(false);
    expect(canResolveSelectedLayerFrame({ ...ready, selectedLayerId: null })).toBe(false);
    expect(canResolveSelectedLayerFrame({ ...ready, workspace: "mask" })).toBe(false);
  });
});
