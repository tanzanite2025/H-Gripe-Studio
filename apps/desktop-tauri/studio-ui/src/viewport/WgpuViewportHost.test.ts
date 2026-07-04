// Exercises the Phase 1 host lifecycle against the mock transport (vitest runs
// outside Tauri, so the bridge takes the browser-preview path).

import { describe, expect, it } from "vitest";
import { openMockViewportCount, registerLayeredAsset } from "../bridge/viewport";
import { WgpuViewportHost } from "./WgpuViewportHost";

describe("WgpuViewportHost", () => {
  it("creates no viewport at import/startup time", () => {
    expect(openMockViewportCount()).toBe(0);
  });

  it("runs the full open -> target -> render -> close lifecycle", async () => {
    const host = await WgpuViewportHost.open("image_edit");
    expect(host.isOpen).toBe(true);
    expect(host.backend.actual).toBe("cpu");
    expect(openMockViewportCount()).toBe(1);

    await host.command({ kind: "resize", width: 640, height: 480 });
    await host.command({ kind: "set_target", target: { kind: "image", resourceId: "res-1" } });
    const frame = await host.renderFrame();
    expect(frame.data_url.startsWith("data:image/")).toBe(true);
    expect(frame.width).toBe(640);
    expect(frame.backend.fallback_reason).toBeTruthy();

    await host.close();
    expect(host.isOpen).toBe(false);
    expect(openMockViewportCount()).toBe(0);
  });

  it("refuses to render before a target is set", async () => {
    const host = await WgpuViewportHost.open("grade_preview");
    await expect(host.renderFrame()).rejects.toThrow(/no target/);
    await host.close();
  });

  it("resolves image_layer targets through the layered asset registry", async () => {
    const host = await WgpuViewportHost.open("image_edit");
    // Unregistered assets and layers fail at set time, not at first render.
    await expect(
      host.command({
        kind: "set_target",
        target: { kind: "image_layer", assetId: "layered-n1", layerId: "layer_subject" },
      }),
    ).rejects.toThrow(/unknown layered asset id/);

    await registerLayeredAsset("layered-n1", [
      { layerId: "layer_subject", rgbaPath: "/tmp/subject.png" },
    ]);
    await expect(
      host.command({
        kind: "set_target",
        target: { kind: "image_layer", assetId: "layered-n1", layerId: "layer_missing" },
      }),
    ).rejects.toThrow(/unknown layer id/);

    await host.command({
      kind: "set_target",
      target: { kind: "image_layer", assetId: "layered-n1", layerId: "layer_subject" },
    });
    await host.command({ kind: "resize", width: 320, height: 240 });
    const frame = await host.renderFrame();
    expect(frame.data_url.startsWith("data:image/")).toBe(true);

    // Registration validates its inputs like the desktop host.
    await expect(registerLayeredAsset("", [])).rejects.toThrow(/must not be empty/);
    await expect(registerLayeredAsset("layered-empty", [])).rejects.toThrow(/no layers/);

    await host.close();
  });

  it("close is idempotent and commands fail after close", async () => {
    const host = await WgpuViewportHost.open("video_preview");
    await host.close();
    await host.close();
    expect(openMockViewportCount()).toBe(0);
    await expect(host.renderFrame()).rejects.toThrow(/closed/);
    await expect(host.command({ kind: "resize", width: 1, height: 1 })).rejects.toThrow(/closed/);
  });
});
