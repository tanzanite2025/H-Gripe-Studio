import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeWindow,
  minimizeWindow,
  startWindowDrag,
  toggleMaximizeWindow,
} from "./windowControls";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native window controls", () => {
  it("invokes the registered Tauri commands", async () => {
    const invoke = vi.fn(async () => undefined);
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });

    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();
    await startWindowDrag();

    expect(invoke.mock.calls).toEqual([
      ["window_minimize"],
      ["window_toggle_maximize"],
      ["window_close"],
      ["window_start_drag"],
    ]);
  });

  it("degrades to no-ops in the browser preview", async () => {
    vi.stubGlobal("window", {});

    await expect(minimizeWindow()).resolves.toBeUndefined();
    await expect(toggleMaximizeWindow()).resolves.toBeUndefined();
    await expect(closeWindow()).resolves.toBeUndefined();
    await expect(startWindowDrag()).resolves.toBeUndefined();
  });
});
