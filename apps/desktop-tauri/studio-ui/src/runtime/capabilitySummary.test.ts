import { describe, expect, it } from "vitest";

import type { DeviceRegistrySnapshot } from "../bridge/deviceRegistry";
import type { EngineProbeReport } from "../bridge/engineProbe";
import { summarizeCapabilities, summarizeDeviceRegistry } from "./capabilitySummary";

const ortBox: EngineProbeReport = {
  cards: [
    {
      node_kind: "matchLightColor",
      engines: {
        cpu: { available: true, reason: "built-in" },
        onnx_harmonize: { available: true, reason: "runtime + weight present" },
      },
    },
    {
      node_kind: "detailWatchdog",
      engines: {
        rules: { available: true, reason: "built-in" },
        onnx_defect: { available: false, reason: "missing optional dependency: onnxruntime" },
      },
    },
  ],
  model_cache_dir: "C:/models",
  runtime: {
    onnxruntime: {
      installed: true,
      version: "1.24.2",
      runtime_flavor: "windows-x64-cpu",
      packaged_providers: ["cpu"],
      providers: ["cpu"],
    },
  },
};

describe("summarizeCapabilities", () => {
  it("summarises runtime, cache dir and per-card engines", () => {
    const lines = summarizeCapabilities(ortBox);
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["onnxruntime"].value).toBe(
      "1.24.2 (windows-x64-cpu); packaged cpu; usable cpu",
    );
    expect(byLabel["model cache"].value).toBe("C:/models");
    expect(byLabel["matchLightColor"]).toEqual({
      label: "matchLightColor",
      value: "cpu, onnx_harmonize",
      tone: "ok",
    });
    expect(byLabel["detailWatchdog"].value).toBe("rules; unavailable: onnx_defect");
    expect(byLabel["detailWatchdog"].tone).toBe("warn");
  });

  it("reports the CPU ORT payload without obsolete Torch or CUDA probe lines", () => {
    const lines = summarizeCapabilities({
      cards: [],
      runtime: {
        onnxruntime: {
          installed: true,
          version: "1.24.2",
          runtime_flavor: "windows-x64-cpu",
          packaged_providers: ["cpu"],
          providers: ["cpu"],
        },
      },
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["cuda"]).toBeUndefined();
    expect(byLabel["torch"]).toBeUndefined();
    expect(byLabel["onnxruntime"].tone).toBe("ok");
  });

  it("summarises the wgpu and ffmpeg backend probes with fallback visible", () => {
    const lines = summarizeCapabilities({
      cards: [],
      wgpu: { available: true, detail: "NVIDIA GeForce RTX 4090 (Vulkan)" },
      ffmpeg: { available: false, detail: "native-ffmpeg feature disabled (no vendored libav decoder)" },
      ffmpeg_hw: {
        available: false,
        detail: "no hardware encoders in the vendored libav (software x264 only)",
      },
      ffmpeg_hw_decode: {
        available: false,
        detail: "no hardware decoders in the vendored libav (software decode only)",
      },
      display_adapters: {
        available: true,
        detail: "NVIDIA GeForce RTX 4090 (Vulkan), NVIDIA GeForce RTX 4090 (Dx12)",
      },
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["wgpu"]).toEqual({
      label: "wgpu",
      value: "NVIDIA GeForce RTX 4090 (Vulkan)",
      tone: "ok",
    });
    expect(byLabel["ffmpeg"]).toEqual({
      label: "ffmpeg",
      value: "native-ffmpeg feature disabled (no vendored libav decoder)",
      tone: "warn",
    });
    expect(byLabel["display adapters"]).toEqual({
      label: "display adapters",
      value: "NVIDIA GeForce RTX 4090 (Vulkan), NVIDIA GeForce RTX 4090 (Dx12)",
      tone: "ok",
    });
    expect(byLabel["ffmpeg hw encoders"]).toEqual({
      label: "ffmpeg hw encoders",
      value: "no hardware encoders in the vendored libav (software x264 only)",
      tone: "warn",
    });
    expect(byLabel["ffmpeg hw decoders"]).toEqual({
      label: "ffmpeg hw decoders",
      value: "no hardware decoders in the vendored libav (software decode only)",
      tone: "warn",
    });
  });

  it("lists compiled-in hardware encoders and decoders as ok lines", () => {
    const lines = summarizeCapabilities({
      cards: [],
      ffmpeg_hw: { available: true, detail: "h264_nvenc, hevc_nvenc" },
      ffmpeg_hw_decode: { available: true, detail: "h264_cuvid, hevc_cuvid" },
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["ffmpeg hw encoders"]).toEqual({
      label: "ffmpeg hw encoders",
      value: "h264_nvenc, hevc_nvenc",
      tone: "ok",
    });
    expect(byLabel["ffmpeg hw decoders"]).toEqual({
      label: "ffmpeg hw decoders",
      value: "h264_cuvid, hevc_cuvid",
      tone: "ok",
    });
  });

  it("keeps a failed display-adapter probe visible as a warn line", () => {
    const lines = summarizeCapabilities({
      cards: [],
      display_adapters: { available: false, detail: "no display adapters detected" },
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["display adapters"]).toEqual({
      label: "display adapters",
      value: "no display adapters detected",
      tone: "warn",
    });
  });

  it("reports a probe that never ran and per-card probe errors", () => {
    const lines = summarizeCapabilities({
      cards: [
        { node_kind: "imageEnhance", engines: {}, error: "probe failed" },
      ],
      model_cache_dir: null,
    });
    expect(lines[0]).toEqual({ label: "runtime", value: "probe did not run", tone: "warn" });
    expect(lines[1]).toEqual({ label: "imageEnhance", value: "probe failed", tone: "warn" });
  });
});

describe("summarizeDeviceRegistry", () => {
  const base: DeviceRegistrySnapshot = {
    adapters: [],
    grade_wgpu: { available: true, detail: "NVIDIA GeForce RTX 4090 (Vulkan)" },
    viewport_surface: {
      available: false,
      detail: "not initialised yet (initialises on the first presented viewport)",
    },
    ffmpeg: { available: true, detail: "vendored libav (software decode)" },
    ffmpeg_hw_encoders: [],
    ffmpeg_hw_decoders: [],
    onnx_runtime: {
      available: true,
      detail: "ONNX Runtime 1.24.2 (windows-x64-cpu); packaged: cpu; usable: cpu",
    },
    onnx_providers: ["cpu"],
  };

  it("lists adapters with their wgpu limits", () => {
    const lines = summarizeDeviceRegistry({
      ...base,
      adapters: [
        {
          name: "NVIDIA GeForce RTX 4090",
          backend: "Vulkan",
          max_texture_dimension_2d: 16384,
          max_buffer_size: 2147483648,
        },
      ],
      ffmpeg_hw_encoders: ["h264_nvenc"],
      ffmpeg_hw_decoders: ["h264_cuvid"],
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["adapter"]).toEqual({
      label: "adapter",
      value: "NVIDIA GeForce RTX 4090 (Vulkan) — max texture 16384px, max buffer 2.0 GiB",
      tone: "ok",
    });
    expect(byLabel["grade wgpu"].tone).toBe("ok");
    expect(byLabel["ffmpeg hw encoders"]).toEqual({
      label: "ffmpeg hw encoders",
      value: "h264_nvenc",
      tone: "ok",
    });
    expect(byLabel["ffmpeg hw decoders"].value).toBe("h264_cuvid");
  });

  it("keeps every missing capability visible as a warn line", () => {
    const lines = summarizeDeviceRegistry({
      ...base,
      adapters_error: "no display adapters detected",
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["adapter"]).toEqual({
      label: "adapter",
      value: "no display adapters detected",
      tone: "warn",
    });
    expect(byLabel["viewport surface"].tone).toBe("warn");
    expect(byLabel["viewport surface"].value).toContain("not initialised");
    expect(byLabel["ffmpeg hw encoders"]).toEqual({
      label: "ffmpeg hw encoders",
      value: "none compiled in",
      tone: "warn",
    });
    expect(byLabel["ffmpeg hw decoders"].value).toBe("none compiled in");
    expect(byLabel["onnx providers"]).toEqual({
      label: "onnx providers",
      value: "cpu",
      tone: "warn",
    });
  });

  it("keeps the last uncaptured GPU error visible as a warn line", () => {
    const lines = summarizeDeviceRegistry({
      ...base,
      viewport_surface: { available: true, detail: "NVIDIA GeForce RTX 4090 (Dx12)" },
      viewport_surface_last_error:
        "wgpu uncaptured out-of-memory error: not enough memory left",
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["viewport surface last GPU error"]).toEqual({
      label: "viewport surface last GPU error",
      value: "wgpu uncaptured out-of-memory error: not enough memory left",
      tone: "warn",
    });
    // Absent error records no line.
    const withoutError = summarizeDeviceRegistry(base);
    expect(withoutError.some((l) => l.label === "viewport surface last GPU error")).toBe(false);
  });

  it("marks accelerated onnx providers as ok", () => {
    const lines = summarizeDeviceRegistry({ ...base, onnx_providers: ["cpu", "cuda"] });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l]));
    expect(byLabel["onnx providers"]).toEqual({
      label: "onnx providers",
      value: "cpu, cuda",
      tone: "ok",
    });
  });
});
