// Capability probe summary (GPU_DEVICE_STRATEGY_PLAN, short-term step 6): one
// diagnostic snapshot aggregating the probes that already exist, rendered as
// plain lines the Model Manager (and future dashboards) can display. This is
// diagnostics only — per-run DeviceReports remain the source of truth for what
// actually ran, because a model can still fail on GPU due to memory,
// unsupported ops, or a specific codec.

import type { DeviceRegistrySnapshot } from "../bridge/deviceRegistry";
import type { EngineProbeReport } from "../bridge/engineProbe";

/** One diagnostic line of the capability snapshot. */
export interface CapabilityLine {
  label: string;
  value: string;
  /** `ok` renders neutral; `warn` marks a missing/fallback capability. */
  tone: "ok" | "warn";
}

/**
 * Flatten an `EngineProbeReport` into display lines: machine compute
 * capability first (selected ONNX runtime and providers), then one line
 * per probed card summarising available vs unavailable engines. An empty
 * report (browser preview / probe never ran) yields a single warn line.
 */
export function summarizeCapabilities(report: EngineProbeReport): CapabilityLine[] {
  const lines: CapabilityLine[] = [];
  const runtime = report.runtime;
  if (runtime) {
    const onnx = runtime.onnxruntime;
    const packaged = onnx.packaged_providers.join(", ") || "none";
    const usable = onnx.providers.join(", ") || "none";
    lines.push({
      label: "onnxruntime",
      value: onnx.installed
        ? `${onnx.version ?? "installed"} (${onnx.runtime_flavor}); packaged ${packaged}; usable ${usable}`
        : `${onnx.runtime_flavor}; packaged ${packaged}; ${onnx.reason ?? "not loadable"}`,
      tone: onnx.installed ? "ok" : "warn",
    });
  } else {
    lines.push({ label: "runtime", value: "probe did not run", tone: "warn" });
  }
  if (report.display_adapters) {
    lines.push({
      label: "display adapters",
      value: report.display_adapters.detail,
      tone: report.display_adapters.available ? "ok" : "warn",
    });
  }
  if (report.wgpu) {
    lines.push({
      label: "wgpu",
      value: report.wgpu.detail,
      tone: report.wgpu.available ? "ok" : "warn",
    });
  }
  if (report.ffmpeg) {
    lines.push({
      label: "ffmpeg",
      value: report.ffmpeg.detail,
      tone: report.ffmpeg.available ? "ok" : "warn",
    });
  }
  if (report.ffmpeg_hw) {
    lines.push({
      label: "ffmpeg hw encoders",
      value: report.ffmpeg_hw.detail,
      tone: report.ffmpeg_hw.available ? "ok" : "warn",
    });
  }
  if (report.ffmpeg_hw_decode) {
    lines.push({
      label: "ffmpeg hw decoders",
      value: report.ffmpeg_hw_decode.detail,
      tone: report.ffmpeg_hw_decode.available ? "ok" : "warn",
    });
  }
  if (report.model_cache_dir) {
    lines.push({ label: "model cache", value: report.model_cache_dir, tone: "ok" });
  }
  for (const card of report.cards) {
    if (card.error) {
      lines.push({ label: card.node_kind, value: card.error, tone: "warn" });
      continue;
    }
    const entries = Object.entries(card.engines);
    const available = entries.filter(([, e]) => e.available).map(([id]) => id);
    const missing = entries.filter(([, e]) => !e.available).map(([id]) => id);
    lines.push({
      label: card.node_kind,
      value:
        missing.length === 0
          ? available.join(", ")
          : `${available.join(", ")}; unavailable: ${missing.join(", ")}`,
      tone: missing.length === 0 ? "ok" : "warn",
    });
  }
  return lines;
}

const GIB = 1024 * 1024 * 1024;

/**
 * Flatten a central device-registry snapshot (GPU_DEVICE_STRATEGY_PLAN step
 * 13) into display lines: enumerated adapters with their wgpu limits first,
 * then the compiled-in kernel backends, FFmpeg hardware codec names, and
 * onnxruntime providers. Diagnostics only — per-run DeviceReports remain the
 * source of truth for what actually ran.
 */
export function summarizeDeviceRegistry(snapshot: DeviceRegistrySnapshot): CapabilityLine[] {
  const lines: CapabilityLine[] = [];
  if (snapshot.adapters.length > 0) {
    for (const adapter of snapshot.adapters) {
      lines.push({
        label: "adapter",
        value: `${adapter.name} (${adapter.backend}) — max texture ${adapter.max_texture_dimension_2d}px, max buffer ${(adapter.max_buffer_size / GIB).toFixed(1)} GiB`,
        tone: "ok",
      });
    }
  } else {
    lines.push({
      label: "adapter",
      value: snapshot.adapters_error ?? "no display adapters detected",
      tone: "warn",
    });
  }
  const entries: Array<[string, { available: boolean; detail: string }]> = [
    ["grade wgpu", snapshot.grade_wgpu],
    ["viewport surface", snapshot.viewport_surface],
    ["ffmpeg", snapshot.ffmpeg],
    ["onnx runtime", snapshot.onnx_runtime],
  ];
  for (const [label, entry] of entries) {
    lines.push({ label, value: entry.detail, tone: entry.available ? "ok" : "warn" });
    if (label === "viewport surface" && snapshot.viewport_surface_last_error) {
      lines.push({
        label: "viewport surface last GPU error",
        value: snapshot.viewport_surface_last_error,
        tone: "warn",
      });
    }
  }
  lines.push({
    label: "ffmpeg hw encoders",
    value: snapshot.ffmpeg_hw_encoders.length > 0 ? snapshot.ffmpeg_hw_encoders.join(", ") : "none compiled in",
    tone: snapshot.ffmpeg_hw_encoders.length > 0 ? "ok" : "warn",
  });
  lines.push({
    label: "ffmpeg hw decoders",
    value: snapshot.ffmpeg_hw_decoders.length > 0 ? snapshot.ffmpeg_hw_decoders.join(", ") : "none compiled in",
    tone: snapshot.ffmpeg_hw_decoders.length > 0 ? "ok" : "warn",
  });
  lines.push({
    label: "onnx providers",
    value: snapshot.onnx_providers.join(", ") || "none usable",
    tone: snapshot.onnx_providers.some((p) => p !== "cpu") ? "ok" : "warn",
  });
  return lines;
}
