import { tauriInvoke } from "./core";

// --- Central device registry --------------------------------------------------
// GPU_DEVICE_STRATEGY_PLAN step 13: one Rust-side snapshot of what compute
// capability this box has — display adapters with their wgpu limits, the
// compiled-in kernel backends, FFmpeg hardware codec names, and onnxruntime
// execution providers. Diagnostics only: per-run DeviceReports remain the
// source of truth for what actually ran.

/** One enumerated display adapter with its key wgpu limits (mirrors Rust `AdapterRecord`). */
export interface AdapterRecord {
  name: string;
  backend: string;
  max_texture_dimension_2d: number;
  max_buffer_size: number;
}

/** One capability entry: available with detail, or unavailable with the reason. */
export interface RegistryEntry {
  available: boolean;
  detail: string;
}

/** The registry snapshot (mirrors Rust `DeviceRegistrySnapshot`). */
export interface DeviceRegistrySnapshot {
  /** Display adapters (the same physical GPU may appear once per backend). */
  adapters: AdapterRecord[];
  /** Why enumeration produced no adapters, when `adapters` is empty. */
  adapters_error?: string | null;
  /** Grade kernel wgpu device. */
  grade_wgpu: RegistryEntry;
  /** Shared viewport surface device (cached state; never initialised by a snapshot). */
  viewport_surface: RegistryEntry;
  /** Vendored FFmpeg software baseline. */
  ffmpeg: RegistryEntry;
  /** Hardware encoder names compiled into the vendored libav. */
  ffmpeg_hw_encoders: string[];
  /** Hardware decoder names compiled into the vendored libav. */
  ffmpeg_hw_decoders: string[];
  /** onnxruntime execution providers compiled into this build. */
  onnx_providers: string[];
}

/**
 * Read the central device registry (`device_registry_snapshot`). Outside the
 * desktop shell (browser preview) there is no registry; `null` lets callers
 * skip the section rather than render an empty snapshot.
 */
export async function deviceRegistrySnapshot(): Promise<DeviceRegistrySnapshot | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return (await invoke("device_registry_snapshot", {})) as DeviceRegistrySnapshot;
}
