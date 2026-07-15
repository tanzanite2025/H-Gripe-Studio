import { tauriInvoke } from "./core";

// --- Engine capability probe ------------------------------------------------
// The `doctor`-style cross-card probe behind the opt-in ML `engine` seams. The
// backend exposes it for diagnostics and a future Inspector/settings consumer;
// the current Inspector does not disable engine choices from this report.

/** Cached-weight inventory for one engine (mirrors Rust `WeightInfo`). */
export interface WeightInfo {
  /** Path of the non-bundled weight this engine would load. */
  path: string;
  /** Whether that weight is already present on this box. */
  present: boolean;
  /** Size in MB for a file weight; `null` for a directory weight (HF snapshot). */
  size_mb?: number | null;
}

/**
 * Preflight availability of one `engine` option. Lazy model sessions can still
 * fail validation on first use, so per-run telemetry is authoritative.
 */
export interface EngineAvailability {
  available: boolean;
  reason: string;
  /**
   * Whether this build can use an accelerated provider for the engine. CPU-only
   * learned engines and CPU/`rules`/`provider` baselines are `false`.
   */
  accelerated?: boolean;
  /**
   * Cached-weight inventory: which non-bundled weight this engine loads and
   * whether it is present. Absent for the CPU/`rules`/`provider` baseline.
   */
  weight?: WeightInfo | null;
}

/** Per-card engine probe (mirrors Rust `CardEngineProbe`). */
export interface CardEngineProbe {
  /** Node kind whose `engine` param these cover, e.g. `imageEnhance`. */
  node_kind: string;
  /** Bridge CLI that produced the probe. */
  cli: string;
  /** Engine id -> availability (e.g. `cpu`/`realesrgan`, `rules`/`onnx_defect`). */
  engines: Record<string, EngineAvailability>;
  /** Why the probe could not run, when `engines` is empty. */
  error?: string | null;
}

/** One CUDA device from the device probe (mirrors Rust `DeviceInfo`). */
export interface DeviceInfo {
  index: number;
  name: string;
  total_memory_mb: number;
}

/** `torch` presence + CUDA flag (mirrors Rust `TorchInfo`). */
export interface TorchInfo {
  installed: boolean;
  version?: string | null;
  cuda?: boolean | null;
  reason?: string | null;
}

/** `onnxruntime` presence + execution providers (mirrors Rust `OnnxRuntimeInfo`). */
export interface OnnxRuntimeInfo {
  installed: boolean;
  version?: string | null;
  providers: string[];
  reason?: string | null;
}

/**
 * Machine compute capability (mirrors Rust `DeviceProbe`): which accelerator
 * the opt-in GPU engines would actually run on. The per-card probes say *which*
 * engines could run; this says *where*, so the inspector can warn that a GPU
 * engine falls back to CPU on a box with no CUDA device.
 */
export interface DeviceProbe {
  cuda_available: boolean;
  devices: DeviceInfo[];
  torch: TorchInfo;
  onnxruntime: OnnxRuntimeInfo;
}

/**
 * One compiled-in kernel backend's probe (mirrors Rust `BackendProbe`):
 * whether it is usable on this box, with the adapter/library detail when it
 * is and the reason when it is not.
 */
export interface BackendProbe {
  available: boolean;
  detail: string;
}

/** Cross-card engine capability report (mirrors Rust `EngineProbeReport`). */
export interface EngineProbeReport {
  cards: CardEngineProbe[];
  /** Shared weight cache (`HGRIPE_MODEL_CACHE` or the bundled dir). */
  model_cache_dir?: string | null;
  /** Machine compute capability, probed once; absent when it could not run. */
  runtime?: DeviceProbe | null;
  /** Grade kernel wgpu adapter status. */
  wgpu?: BackendProbe | null;
  /** Vendored FFmpeg decode status (software path). */
  ffmpeg?: BackendProbe | null;
  /** Hardware video encoders compiled into the vendored libav (probe only). */
  ffmpeg_hw?: BackendProbe | null;
  /** Hardware video decoders compiled into the vendored libav (probe only —
   * playback stays on the software baseline). */
  ffmpeg_hw_decode?: BackendProbe | null;
  /** Detected display adapters across every compiled wgpu backend. */
  display_adapters?: BackendProbe | null;
}

/**
 * Probe the opt-in ML `engine` seams across local cards (`probe_engines`).
 *
 * Outside the desktop shell (browser preview) there is no native capability
 * backend, so we return an empty report; the inspector then leaves every engine
 * enabled rather than greying options out from a probe that never ran.
 */
export async function probeEngines(): Promise<EngineProbeReport> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return { cards: [], model_cache_dir: null };
  }
  return (await invoke("probe_engines", { dir: null })) as EngineProbeReport;
}

// --- On-demand cache ---------------------------------------------------------
// Probing is a user-initiated diagnostic (a "check engines" button, a model
// manager), never an automatic UI side effect: showing an engine dropdown
// costs nothing and reads only the node spec. Concurrent callers share one
// in-flight invoke (single-flight) and results are reused for a TTL; `force`
// bypasses the cache for a manual refresh.

const PROBE_TTL_MS = 5 * 60_000;

let cachedReport: EngineProbeReport | null = null;
let cachedAt = 0;
let inflight: Promise<EngineProbeReport> | null = null;

/** Last completed probe report, if any (no invoke). */
export function lastEngineProbe(): EngineProbeReport | null {
  return cachedReport;
}

/** Cached, single-flight `probeEngines`. `force` refreshes past the TTL. */
export function probeEnginesCached(force = false): Promise<EngineProbeReport> {
  if (!force && cachedReport && Date.now() - cachedAt < PROBE_TTL_MS) {
    return Promise.resolve(cachedReport);
  }
  if (!inflight) {
    inflight = probeEngines()
      .then((report) => {
        cachedReport = report;
        cachedAt = Date.now();
        return report;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
