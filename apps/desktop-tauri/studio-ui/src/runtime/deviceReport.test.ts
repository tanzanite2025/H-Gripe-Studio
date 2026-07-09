import { describe, expect, it } from "vitest";

import {
  describeDeviceReport,
  deviceReportFromEngineReport,
  deviceReportFromNodeOutputs,
  deviceReportFromPluginReport,
  deviceReportFromViewportBackend,
} from "./deviceReport";

describe("deviceReportFromEngineReport", () => {
  it("treats the cpu baseline engine as non-accelerated cpu", () => {
    const report = deviceReportFromEngineReport({
      engine: "cpu",
      engine_requested: "cpu",
      engine_fallback_reason: null,
      device: null,
      device_requested: "auto",
    });
    expect(report).toEqual({
      requested: "auto",
      used: "cpu",
      backend: "cpu",
      accelerated: false,
      fallbackReason: undefined,
    });
  });

  it("maps an accelerated engine on cuda with precision", () => {
    const report = deviceReportFromEngineReport({
      engine: "realesrgan",
      engine_requested: "realesrgan",
      device: "cuda",
      device_requested: "auto",
      precision: "fp16",
    });
    expect(report).toEqual({
      requested: "auto",
      used: "cuda",
      backend: "realesrgan fp16",
      accelerated: true,
      fallbackReason: undefined,
    });
  });

  it("keeps an explicit cpu request from ever reporting cuda (fallback visible)", () => {
    const report = deviceReportFromEngineReport({
      engine: "cpu",
      engine_requested: "realesrgan",
      engine_fallback_reason: "missing optional dependency: torch",
      device: null,
      device_requested: "cpu",
    });
    expect(report?.requested).toBe("cpu");
    expect(report?.used).toBe("cpu");
    expect(report?.accelerated).toBe(false);
    expect(report?.fallbackReason).toBe("missing optional dependency: torch");
  });

  it("maps the provider path and the rules baseline", () => {
    expect(
      deviceReportFromEngineReport({ engine: "provider", engine_requested: "sd_inpaint" })?.used,
    ).toBe("provider");
    expect(deviceReportFromEngineReport({ engine: "rules", engine_requested: "rules" })?.used).toBe(
      "cpu",
    );
  });

  it("returns null when a report carries no engine telemetry", () => {
    expect(deviceReportFromEngineReport({})).toBeNull();
  });

  it("reports unknown (not accelerated) when an ML engine has no device field", () => {
    const report = deviceReportFromEngineReport({
      engine: "onnx_matting",
      engine_requested: "onnx_matting",
      device: null,
    });
    expect(report?.used).toBe("unknown");
    expect(report?.accelerated).toBe(false);
  });
});

describe("deviceReportFromViewportBackend", () => {
  it("maps a wgpu frame as accelerated", () => {
    expect(deviceReportFromViewportBackend({ requested: "auto", actual: "wgpu" })).toEqual({
      requested: "auto",
      used: "wgpu",
      backend: "wgpu",
      accelerated: true,
      fallbackReason: undefined,
    });
  });

  it("folds clip-property backend and timing into the viewport device report", () => {
    const report = deviceReportFromViewportBackend({
      requested: "auto",
      actual: "wgpu",
      props_backend: "cpu",
      props_fallback_reason: "adapter unavailable",
      decode_processing_time_ms: 0.75,
      props_processing_time_ms: 1.25,
      grade_processing_time_ms: 0.5,
    });
    expect(report.props).toEqual({
      used: "cpu",
      backend: undefined,
      fallbackReason: "adapter unavailable",
      processingTimeMs: 1.25,
    });
    expect(report.stages).toEqual({
      decodeMs: 0.75,
      propsMs: 1.25,
      gradeMs: 0.5,
    });
    expect(describeDeviceReport(report)).toContain(
      "props cpu (fallback: adapter unavailable)",
    );
    expect(describeDeviceReport(report)).toContain(
      "stages decode 0.75ms / props 1.25ms / grade 0.50ms",
    );
  });

  it("carries the adapter detail into the backend text when present", () => {
    const report = deviceReportFromViewportBackend({
      requested: "auto",
      actual: "wgpu",
      detail: "NVIDIA GeForce RTX 4090 (Vulkan)",
    });
    expect(report.used).toBe("wgpu");
    expect(report.backend).toBe("NVIDIA GeForce RTX 4090 (Vulkan)");
    expect(report.accelerated).toBe(true);
  });

  it("keeps cpu fallback visible with its reason", () => {
    const report = deviceReportFromViewportBackend({
      requested: "gpu",
      actual: "cpu",
      fallback_reason: "png transport (frame not presented on the native surface)",
    });
    expect(report.used).toBe("cpu");
    expect(report.accelerated).toBe(false);
    expect(report.fallbackReason).toBe("png transport (frame not presented on the native surface)");
  });
});

describe("describeDeviceReport", () => {
  it("renders requested -> used with backend and fallback notes", () => {
    expect(
      describeDeviceReport({
        requested: "auto",
        used: "cuda",
        backend: "realesrgan fp16",
        accelerated: true,
      }),
    ).toBe("device auto -> cuda (realesrgan fp16)");
    expect(
      describeDeviceReport({
        requested: "cuda",
        used: "cpu",
        backend: "cpu",
        accelerated: false,
        fallbackReason: "CUDA provider unavailable",
      }),
    ).toBe("device cuda -> cpu (fallback: CUDA provider unavailable)");
  });

  it("renders the decode half as its own note", () => {
    expect(
      describeDeviceReport({
        requested: "gpu",
        used: "ffmpeg_hw",
        backend: "ffmpeg",
        accelerated: true,
        decode: {
          used: "ffmpeg_sw",
          fallbackReason: "no hardware decoder for 'vp9' compiled into the vendored libav",
        },
      }),
    ).toBe(
      "device gpu -> ffmpeg_hw (ffmpeg; decode ffmpeg_sw (fallback: no hardware decoder for 'vp9' compiled into the vendored libav))",
    );
  });

  it("omits the arrow when no request was recorded", () => {
    expect(describeDeviceReport({ used: "wgpu", backend: "wgpu", accelerated: true })).toBe(
      "device wgpu",
    );
  });
});

describe("deviceReportFromNodeOutputs", () => {
  it("finds engine telemetry in a *_report output", () => {
    const report = deviceReportFromNodeOutputs({
      enhanced_image: "/out/x.png",
      enhance_report: {
        engine: "realesrgan",
        engine_requested: "realesrgan",
        device: "cuda",
        device_requested: "auto",
        precision: "fp16",
      },
    });
    expect(report?.used).toBe("cuda");
    expect(report?.backend).toBe("realesrgan fp16");
  });

  it("returns null when no output carries telemetry", () => {
    expect(deviceReportFromNodeOutputs({ image: "/out/x.png" })).toBeNull();
    expect(deviceReportFromNodeOutputs({ repaint_report: { status: "unchanged" } })).toBeNull();
  });

  it("reads subjectMask matte_report telemetry with its provider fallback visible", () => {
    const report = deviceReportFromNodeOutputs({
      mask: "/out/mask.png",
      matte_report: {
        mode: "auto_subject",
        provider: "birefnet",
        engine: "onnxruntime",
        device: "cpu",
        device_requested: "auto",
        engine_fallback_reason:
          "onnxruntime CPU execution provider (no CUDA/DirectML provider built in)",
      },
    });
    expect(report?.requested).toBe("auto");
    expect(report?.used).toBe("cpu");
    expect(report?.backend).toBe("onnxruntime");
    expect(report?.accelerated).toBe(false);
    expect(report?.fallbackReason).toBe(
      "onnxruntime CPU execution provider (no CUDA/DirectML provider built in)",
    );
  });

  it("normalises a plugin boundary report, keeping a silent downgrade visible", () => {
    const honest = deviceReportFromPluginReport({
      device_requested: "cuda",
      device: "cuda",
      precision_requested: "fp16",
      precision: "fp16",
      backend: "torch-plugin",
    });
    expect(honest.used).toBe("cuda");
    expect(honest.accelerated).toBe(true);
    expect(honest.backend).toBe("torch-plugin fp16");
    expect(honest.fallbackReason).toBeUndefined();

    const silentDowngrade = deviceReportFromPluginReport({
      device_requested: "cuda",
      device: "cpu",
      precision_requested: "fp16",
      precision: "fp32",
    });
    expect(silentDowngrade.used).toBe("cpu");
    expect(silentDowngrade.accelerated).toBe(false);
    expect(silentDowngrade.fallbackReason).toBe(
      "plugin ran on cpu for a cuda request; precision fp16 -> fp32 (no reason reported)",
    );

    const reported = deviceReportFromPluginReport({
      device_requested: "cuda",
      device: "cpu",
      fallback_reason: "CUDA out of memory",
    });
    expect(reported.fallbackReason).toBe("CUDA out of memory");
  });

  it("reads videoAssemble assemble_report as the software FFmpeg baseline", () => {
    const report = deviceReportFromNodeOutputs({
      video: "/out/clip.mp4",
      assemble_report: {
        codec: "libx264",
        engine: "ffmpeg",
        device: "ffmpeg_sw",
        device_requested: "auto",
        engine_fallback_reason:
          "hardware encode not enabled (vendored libav software baseline)",
      },
    });
    expect(report?.requested).toBe("auto");
    expect(report?.used).toBe("ffmpeg_sw");
    expect(report?.decode).toBeUndefined();
    expect(report?.backend).toBe("ffmpeg");
    expect(report?.accelerated).toBe(false);
    expect(report?.fallbackReason).toBe(
      "hardware encode not enabled (vendored libav software baseline)",
    );
  });

  it("reads videoTrim trim_report with the decode half kept visible", () => {
    const report = deviceReportFromNodeOutputs({
      video: "/out/cut.mp4",
      trim_report: {
        codec: "libx264",
        engine: "ffmpeg",
        device: "ffmpeg_sw",
        device_requested: "gpu",
        engine_fallback_reason: "hardware encoder 'h264_nvenc' failed: open error",
        decode_device: "ffmpeg_hw",
        decode_fallback_reason: null,
      },
    });
    expect(report?.requested).toBe("gpu");
    expect(report?.used).toBe("ffmpeg_sw");
    expect(report?.decode).toEqual({ used: "ffmpeg_hw", fallbackReason: undefined });
    // A hardware decode counts as accelerated even when the encode fell back.
    expect(report?.accelerated).toBe(true);
    expect(report?.fallbackReason).toBe(
      "hardware encoder 'h264_nvenc' failed: open error",
    );
  });

  it("skips a manual-lane matte_report that carries no engine telemetry", () => {
    expect(
      deviceReportFromNodeOutputs({
        matte_report: { mode: "hybrid", provider: "rust-native" },
      }),
    ).toBeNull();
  });
});
