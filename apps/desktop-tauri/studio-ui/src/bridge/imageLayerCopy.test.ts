import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyImageEditorDocument } from "../contracts/imageEditorDocument";
import { materializeLayerViaCopy, type MaterializeLayerViaCopyRequest } from "./imageLayerCopy";

const request = (): MaterializeLayerViaCopyRequest => ({
  imagePath: "C:/images/base.png",
  document: emptyImageEditorDocument(),
  selectedLayerId: "layer-1",
  documentWidth: 80,
  documentHeight: 60,
  selection: { region: [20, 30, 24, 32] },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("materializeLayerViaCopy", () => {
  it("invokes the Rust command with the frozen camelCase contract", async () => {
    const result = {
      source: { path: "C:/copies/copy.png", width: 4, height: 2 },
      placement: [20, 30, 24, 32],
    };
    const invoke = vi.fn(async () => result);
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    const input = request();

    await expect(materializeLayerViaCopy(input)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("materialize_layer_via_copy", {
      imagePath: input.imagePath,
      document: input.document,
      selectedLayerId: input.selectedLayerId,
      documentWidth: input.documentWidth,
      documentHeight: input.documentHeight,
      selection: input.selection,
    });
  });

  it("accepts an explicit empty materialization without inventing a layer", async () => {
    const invoke = vi.fn(async () => null);
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    await expect(materializeLayerViaCopy(request())).resolves.toBeNull();
  });

  it.each([
    { source: { path: "", width: 4, height: 2 }, placement: [20, 30, 24, 32] },
    { source: { path: "C:/copy.png", width: 4.5, height: 2 }, placement: [20, 30, 24.5, 32] },
    { source: { path: "C:/copy.png", width: 4, height: 2 }, placement: [20.5, 30, 24.5, 32] },
    { source: { path: "C:/copy.png", width: 4, height: 2 }, placement: [20, 30, 25, 32] },
    { source: { path: "C:/copy.png", width: 4, height: 2 }, placement: [24, 30, 20, 32] },
  ])("rejects malformed or implicitly scaled compact results", async (result) => {
    const invoke = vi.fn(async () => result);
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    await expect(materializeLayerViaCopy(request())).rejects.toThrow("invalid result");
  });

  it("fails closed when the Rust backend is unavailable", async () => {
    vi.stubGlobal("window", {});
    await expect(materializeLayerViaCopy(request())).rejects.toThrow("Rust/Tauri backend");
  });
});
