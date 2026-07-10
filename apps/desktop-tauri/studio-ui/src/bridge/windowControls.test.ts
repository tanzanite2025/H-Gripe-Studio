import { afterEach, describe, expect, it, vi } from "vitest";
import { tauriWindow } from "./core";
import {
  closeWindow,
  minimizeWindow,
  toggleMaximizeWindow,
} from "./windowControls";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native window controls", () => {
  it("exposes the direct window API used by title-bar drag gestures", () => {
    const currentWindow = { startDragging: vi.fn(async () => undefined) };
    vi.stubGlobal("window", {
      __TAURI__: {
        window: { getCurrentWindow: () => currentWindow },
      },
    });

    expect(tauriWindow()).toBe(currentWindow);
  });

  it("invokes the registered Tauri commands", async () => {
    const invoke = vi.fn(async () => undefined);
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });

    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();

    expect(invoke.mock.calls).toEqual([
      ["window_minimize"],
      ["window_toggle_maximize"],
      ["window_close"],
    ]);
  });

  it("degrades to no-ops in the browser preview", async () => {
    vi.stubGlobal("window", {});

    await expect(minimizeWindow()).resolves.toBeUndefined();
    await expect(toggleMaximizeWindow()).resolves.toBeUndefined();
    await expect(closeWindow()).resolves.toBeUndefined();
  });
});
