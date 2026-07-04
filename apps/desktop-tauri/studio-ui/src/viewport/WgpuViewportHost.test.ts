// Exercises the Phase 1 host lifecycle against the mock transport (vitest runs
// outside Tauri, so the bridge takes the browser-preview path).

import { describe, expect, it } from "vitest";
import {
  openMockViewportCount,
  registerLayeredAsset,
  registerNodeOutput,
  registerTimeline,
} from "../bridge/viewport";
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

  it("accepts a mask overlay on image_edit viewports only, and validates it", async () => {
    const overlay = {
      w: 2,
      h: 2,
      data: new Uint8Array(4),
      rgb: [86, 168, 255] as [number, number, number],
      alpha: 0.55,
    };

    const grade = await WgpuViewportHost.open("grade_preview");
    await expect(
      grade.command({ kind: "set_mask_overlay", overlay }),
    ).rejects.toThrow(/does not accept a mask overlay/);
    await grade.close();

    const host = await WgpuViewportHost.open("image_edit");
    await host.command({ kind: "set_mask_overlay", overlay });
    // Wrong buffer length and out-of-range alpha fail loudly.
    await expect(
      host.command({ kind: "set_mask_overlay", overlay: { ...overlay, data: new Uint8Array(3) } }),
    ).rejects.toThrow(/expected 4/);
    await expect(
      host.command({ kind: "set_mask_overlay", overlay: { ...overlay, alpha: 1.5 } }),
    ).rejects.toThrow(/between 0 and 1/);
    // Clearing is accepted.
    await host.command({ kind: "set_mask_overlay", overlay: null });
    await host.close();
  });

  it("resolves node_output targets through the node output registry", async () => {
    const host = await WgpuViewportHost.open("image_edit");
    // Unregistered node outputs fail at set time, not at first render.
    await expect(
      host.command({
        kind: "set_target",
        target: { kind: "node_output", nodeId: "node-1" },
      }),
    ).rejects.toThrow(/unknown node output/);

    await registerNodeOutput("node-1", "/tmp/out.png");
    // The port is part of the key: an unregistered port is still rejected.
    await expect(
      host.command({
        kind: "set_target",
        target: { kind: "node_output", nodeId: "node-1", outputPort: "alt" },
      }),
    ).rejects.toThrow(/unknown node output/);

    await host.command({
      kind: "set_target",
      target: { kind: "node_output", nodeId: "node-1" },
    });
    await host.command({ kind: "resize", width: 320, height: 240 });
    const frame = await host.renderFrame();
    expect(frame.data_url.startsWith("data:image/")).toBe(true);

    // Registration validates its inputs like the desktop host.
    await expect(registerNodeOutput("", "/tmp/out.png")).rejects.toThrow(/must not be empty/);
    await expect(registerNodeOutput("node-1", "/tmp/out.png", "")).rejects.toThrow(
      /empty output port/,
    );
    await host.close();
  });

  it("resolves video_clip targets through the timeline registry", async () => {
    const host = await WgpuViewportHost.open("video_preview");
    // Unregistered timelines and clips fail at set time, not at first render.
    await expect(
      host.command({
        kind: "set_target",
        target: { kind: "video_clip", timelineId: "tl-1", clipId: "clip_a", timeSec: 0.5 },
      }),
    ).rejects.toThrow(/unknown timeline id/);

    await registerTimeline("tl-1", [
      { clipId: "clip_a", kind: "video", path: "/tmp/a.mp4", startSec: 0, durationSec: 2 },
    ]);
    await expect(
      host.command({
        kind: "set_target",
        target: { kind: "video_clip", timelineId: "tl-1", clipId: "clip_missing", timeSec: 0.5 },
      }),
    ).rejects.toThrow(/unknown clip id/);

    await host.command({
      kind: "set_target",
      target: { kind: "video_clip", timelineId: "tl-1", clipId: "clip_a", timeSec: 0.5 },
    });
    await host.command({ kind: "resize", width: 320, height: 240 });
    const frame = await host.renderFrame();
    expect(frame.data_url.startsWith("data:image/")).toBe(true);

    // Registration validates its inputs like the desktop host.
    await expect(registerTimeline("", [])).rejects.toThrow(/must not be empty/);
    // A re-registration replaces the timeline's clip set.
    await registerTimeline("tl-1", []);
    await expect(
      host.command({
        kind: "set_target",
        target: { kind: "video_clip", timelineId: "tl-1", clipId: "clip_a", timeSec: 0.5 },
      }),
    ).rejects.toThrow(/unknown clip id/);
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
