import { describe, expect, it } from "vitest";

import type { EngineProbeReport } from "../bridge/engineProbe";
import { summarizeCapabilities } from "./capabilitySummary";

const cudaBox: EngineProbeReport = {
  cards: [
    {
      node_kind: "imageEnhance",
      cli: "image_enhance_cli.py",
      engines: {
        cpu: { available: true, reason: "built-in" },
        realesrgan: { available: true, reason: "deps + weights present", accelerated: true },
      },
    },
    {
      node_kind: "detailWatchdog",
      cli: "detail_watchdog_cli.py",
      engines: {
        rules: { available: true, reason: "built-in" },
        onnx_defect: { available: false, reason: "missing optional dependency: onnxruntime" },
      },
    },
  ],
  model_cache_dir: "C:/models",
  runtime: {
    cuda_available: true,
    devices: [{ index: 0, name: "RTX 4090", total_memory_mb: 24576 }],
    torch: { installed: true, version: "2.3.0", cuda: true },
    onnxruntime: { installed: true, version: "1.18.0", providers: ["CUDAExecutionProvider", "CPUExecutionProvider"] },
  },
};

describe("summarizeCapabilities", () => {
  it("summarises runtime, cache dir and per-card engines", () => {
    const lines = summarizeCapabilities(cudaBox);
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["cuda"].value).toBe("RTX 4090 (24 GB)");
    expect(byLabel["cuda"].tone).toBe("ok");
    expect(byLabel["torch"].value).toBe("2.3.0 +cuda");
    expect(byLabel["onnxruntime"].value).toBe(
      "1.18.0 — CUDAExecutionProvider, CPUExecutionProvider",
    );
    expect(byLabel["model cache"].value).toBe("C:/models");
    expect(byLabel["imageEnhance"]).toEqual({
      label: "imageEnhance",
      value: "cpu, realesrgan",
      tone: "ok",
    });
    expect(byLabel["detailWatchdog"].value).toBe("rules; unavailable: onnx_defect");
    expect(byLabel["detailWatchdog"].tone).toBe("warn");
  });

  it("marks missing acceleration as warn without hiding the cpu baseline", () => {
    const lines = summarizeCapabilities({
      cards: [],
      runtime: {
        cuda_available: false,
        devices: [],
        torch: { installed: false, reason: "not importable" },
        onnxruntime: { installed: true, version: "1.18.0", providers: ["CPUExecutionProvider"] },
      },
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["cuda"]).toEqual({ label: "cuda", value: "not available", tone: "warn" });
    expect(byLabel["torch"]).toEqual({ label: "torch", value: "not importable", tone: "warn" });
    expect(byLabel["onnxruntime"].tone).toBe("ok");
  });

  it("reports a probe that never ran and per-card probe errors", () => {
    const lines = summarizeCapabilities({
      cards: [
        { node_kind: "imageEnhance", cli: "image_enhance_cli.py", engines: {}, error: "bridge missing" },
      ],
      model_cache_dir: null,
    });
    expect(lines[0]).toEqual({ label: "runtime", value: "probe did not run", tone: "warn" });
    expect(lines[1]).toEqual({ label: "imageEnhance", value: "bridge missing", tone: "warn" });
  });
});
