// Shared device-report vocabulary (GPU_DEVICE_STRATEGY_PLAN, short-term steps
// 2–4): one reporting shape for "what device did this actually run on", no
// matter which kernel produced it. It does not schedule anything — each kernel
// keeps its own resolver — it only normalises the fields that already exist
// into one vocabulary the UI and run logs can display consistently.
//
// Current report sources (device-field inventory, plan step 1):
//
// | Source                                   | requested fields                   | actual fields               | fallback field           |
// | ---------------------------------------- | ---------------------------------- | --------------------------- | ------------------------ |
// | imageEnhance `enhance_report`            | engine_requested, device_requested | engine, device, precision   | engine_fallback_reason   |
// | matchLightColor `match_report`           | engine_requested, device_requested | engine, device              | engine_fallback_reason   |
// | refineMaskEdge `edge_report`             | engine_requested, device_requested | engine, device              | engine_fallback_reason   |
// | detailWatchdog `watchdog_report`         | engine_requested, device_requested | engine, device              | engine_fallback_reason   |
// | detailRepaint `repaint_report`           | engine_requested                   | engine, device, precision   | engine_fallback_reason   |
// | subjectMask `matte_report` (auto modes)  | device_requested                   | engine, device              | engine_fallback_reason   |
// | videoAssemble `assemble_report`          | device_requested                   | engine, device (ffmpeg_sw)  | engine_fallback_reason   |
// | viewport frames (`ViewportBackend`)      | requested (auto|gpu|cpu)           | actual (wgpu|gpu|cpu)       | fallback_reason          |

/** What the caller asked for (`device`/`viewport` request vocabulary). */
export type DeviceRequest = "auto" | "cpu" | "cuda" | "gpu";

/** What actually ran, in one cross-kernel vocabulary. */
export type DeviceUsed =
  | "cpu"
  | "cuda"
  | "wgpu"
  | "directml"
  | "ffmpeg_sw"
  | "ffmpeg_hw"
  | "provider"
  | "unknown";

/** One reporting shape for every accelerated (or fallback) operation. */
export interface DeviceReport {
  requested?: DeviceRequest;
  used: DeviceUsed;
  /** Runtime backend detail (engine id, adapter, provider name…). */
  backend?: string;
  accelerated: boolean;
  fallbackReason?: string;
}

const REQUESTS: DeviceRequest[] = ["auto", "cpu", "cuda", "gpu"];
const USED: DeviceUsed[] = [
  "cpu",
  "cuda",
  "wgpu",
  "directml",
  "ffmpeg_sw",
  "ffmpeg_hw",
  "provider",
  "unknown",
];

function asRequest(value: unknown): DeviceRequest | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (REQUESTS as string[]).includes(v) ? (v as DeviceRequest) : undefined;
}

function asUsed(value: unknown): DeviceUsed | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!v) return null;
  if ((USED as string[]).includes(v)) return v as DeviceUsed;
  if (v === "gpu") return "cuda";
  return "unknown";
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Local-engine telemetry fields shared by the `*_report` node outputs. */
export interface EngineReportLike {
  engine?: string | null;
  engine_requested?: string | null;
  engine_fallback_reason?: string | null;
  device?: string | null;
  device_requested?: string | null;
  precision?: string | null;
}

/** CPU-baseline engine ids: not an accelerated backend, device is plain CPU. */
const BASELINE_ENGINES = new Set(["cpu", "rules", "provider"]);

/**
 * Normalise a local-engine node report (`enhance_report`, `match_report`,
 * `edge_report`, `watchdog_report`, `repaint_report`) into a `DeviceReport`.
 * Returns null when the report carries no engine telemetry at all (e.g. a
 * plain provider-path RepaintReport).
 */
export function deviceReportFromEngineReport(report: EngineReportLike): DeviceReport | null {
  const engine = asText(report.engine);
  if (!engine && !asText(report.engine_requested)) return null;
  const baseline = !engine || BASELINE_ENGINES.has(engine);
  const used: DeviceUsed = baseline
    ? engine === "provider"
      ? "provider"
      : "cpu"
    : asUsed(report.device) ?? "unknown";
  const precision = asText(report.precision);
  const backendParts = [engine, precision].filter(Boolean) as string[];
  return {
    requested: asRequest(report.device_requested),
    used,
    backend: backendParts.length > 0 ? backendParts.join(" ") : undefined,
    // Software FFmpeg is the vendored encode/decode baseline, not an
    // accelerated backend (only `ffmpeg_hw` counts as accelerated).
    accelerated: ACCELERATED.has(used),
    fallbackReason: asText(report.engine_fallback_reason),
  };
}

/**
 * Device report an external model plugin must emit at its boundary (the core
 * app owns no heavy model runtime; it only accepts reports). Mirrors the
 * plan's plugin contract: requested vs actual device and precision, plus a
 * fallback reason when the two differ.
 */
export interface PluginDeviceReportLike {
  device_requested?: string | null;
  device?: string | null;
  precision_requested?: string | null;
  precision?: string | null;
  fallback_reason?: string | null;
  /** Plugin-owned backend detail (runtime/build id). */
  backend?: string | null;
}

/** The `used` values that count as an accelerated backend. */
const ACCELERATED: ReadonlySet<DeviceUsed> = new Set(["cuda", "wgpu", "directml", "ffmpeg_hw"]);

/**
 * Normalise an external plugin's boundary report into a `DeviceReport`,
 * preserving device/precision truthfulness: a plugin may resolve its own
 * device, but a downgrade from the requested device or precision must stay
 * visible — when the plugin omits the reason, one is synthesised rather than
 * letting the downgrade pass silently.
 */
export function deviceReportFromPluginReport(report: PluginDeviceReportLike): DeviceReport {
  const requested = asRequest(report.device_requested);
  const used = asUsed(report.device) ?? "unknown";
  const accelerated = ACCELERATED.has(used);
  const precision = asText(report.precision);
  const precisionRequested = asText(report.precision_requested);
  const notes: string[] = [];
  if ((requested === "cuda" || requested === "gpu") && !accelerated) {
    notes.push(`plugin ran on ${used} for a ${requested} request`);
  }
  if (precisionRequested && precision && precisionRequested !== precision) {
    notes.push(`precision ${precisionRequested} -> ${precision}`);
  }
  const reported = asText(report.fallback_reason);
  const fallbackReason =
    reported ?? (notes.length > 0 ? `${notes.join("; ")} (no reason reported)` : undefined);
  const backendParts = [asText(report.backend) ?? "plugin", precision].filter(
    Boolean,
  ) as string[];
  return {
    requested,
    used,
    backend: backendParts.join(" "),
    accelerated,
    fallbackReason,
  };
}

/** Viewport frame backend info (`ViewportBackend` from `bridge/viewport.ts`). */
export interface ViewportBackendLike {
  requested: string;
  actual: string;
  fallback_reason?: string;
}

/** Normalise a viewport frame's backend report into a `DeviceReport`. */
export function deviceReportFromViewportBackend(backend: ViewportBackendLike): DeviceReport {
  const actual = backend.actual.trim().toLowerCase();
  const used: DeviceUsed = actual === "wgpu" || actual === "gpu" ? "wgpu" : asUsed(actual) ?? "unknown";
  return {
    requested: asRequest(backend.requested),
    used,
    backend: actual === "gpu" ? "wgpu" : asText(backend.actual),
    accelerated: used === "wgpu",
    fallbackReason: asText(backend.fallback_reason),
  };
}

/**
 * One-line human rendering shared by run logs and panels, e.g.
 * `device auto -> cuda (realesrgan fp16)` or
 * `device cuda -> cpu (fallback: CUDA provider unavailable)`.
 */
export function describeDeviceReport(report: DeviceReport): string {
  let line = report.requested
    ? `device ${report.requested} -> ${report.used}`
    : `device ${report.used}`;
  const notes: string[] = [];
  if (report.backend && report.backend !== report.used) notes.push(report.backend);
  if (report.fallbackReason) notes.push(`fallback: ${report.fallbackReason}`);
  if (notes.length > 0) line += ` (${notes.join("; ")})`;
  return line;
}

/** Node output keys that carry local-engine telemetry. */
const REPORT_OUTPUT_KEYS = [
  "enhance_report",
  "match_report",
  "edge_report",
  "watchdog_report",
  "repaint_report",
  "matte_report",
  "assemble_report",
];

/**
 * Extract a `DeviceReport` from a node's run outputs, when any of its
 * `*_report` outputs carries engine telemetry. Used by the run log to append
 * per-node device lines after a run.
 */
export function deviceReportFromNodeOutputs(
  outputs: Record<string, unknown>,
): DeviceReport | null {
  for (const key of REPORT_OUTPUT_KEYS) {
    const value = outputs[key];
    if (!value || typeof value !== "object") continue;
    const report = deviceReportFromEngineReport(value as EngineReportLike);
    if (report) return report;
  }
  return null;
}
