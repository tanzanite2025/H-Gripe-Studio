// Capability probe summary (GPU_DEVICE_STRATEGY_PLAN, short-term step 6): one
// diagnostic snapshot aggregating the probes that already exist, rendered as
// plain lines the Model Manager (and future dashboards) can display. This is
// diagnostics only — per-run DeviceReports remain the source of truth for what
// actually ran, because a model can still fail on GPU due to memory,
// unsupported ops, or a specific codec.

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
 * capability first (CUDA devices, torch, onnxruntime providers), then one line
 * per probed card summarising available vs unavailable engines. An empty
 * report (browser preview / probe never ran) yields a single warn line.
 */
export function summarizeCapabilities(report: EngineProbeReport): CapabilityLine[] {
  const lines: CapabilityLine[] = [];
  const runtime = report.runtime;
  if (runtime) {
    lines.push({
      label: "cuda",
      value: runtime.cuda_available
        ? runtime.devices.map((d) => `${d.name} (${Math.round(d.total_memory_mb / 1024)} GB)`).join(", ") ||
          "available"
        : "not available",
      tone: runtime.cuda_available ? "ok" : "warn",
    });
    lines.push({
      label: "torch",
      value: runtime.torch.installed
        ? `${runtime.torch.version ?? "installed"}${runtime.torch.cuda ? " +cuda" : " (cpu)"}`
        : runtime.torch.reason ?? "not installed",
      tone: runtime.torch.installed ? "ok" : "warn",
    });
    lines.push({
      label: "onnxruntime",
      value: runtime.onnxruntime.installed
        ? `${runtime.onnxruntime.version ?? "installed"}${
            runtime.onnxruntime.providers.length > 0
              ? ` — ${runtime.onnxruntime.providers.join(", ")}`
              : ""
          }`
        : runtime.onnxruntime.reason ?? "not installed",
      tone: runtime.onnxruntime.installed ? "ok" : "warn",
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
