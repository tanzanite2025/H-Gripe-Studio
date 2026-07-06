import { tauriInvoke } from "./core";

// --- Scheduler user controls ---------------------------------------------------
// GPU_DEVICE_STRATEGY_PLAN long-term step 5, "max concurrent GPU jobs": the
// stored width is applied to the Rust StudioScheduler's GPU lane (a resizable
// semaphore). The setting only widens/narrows the gate — running jobs are
// never interrupted, and the backend clamps to its own ceiling.

/** Backend ceiling for the GPU lane width (mirrors Rust `MAX_GPU_JOBS`). */
export const MAX_GPU_JOBS = 4;

const STORAGE_KEY = "hgripe.gpuMaxJobs";

/** The stored lane width, clamped to `1..=MAX_GPU_JOBS`; `1` when unset or
 * unreadable. */
export function getGpuMaxJobs(): number {
  try {
    const raw = Number(globalThis.localStorage.getItem(STORAGE_KEY));
    if (!Number.isInteger(raw)) return 1;
    return Math.min(Math.max(raw, 1), MAX_GPU_JOBS);
  } catch {
    return 1;
  }
}

/** Persist the lane width (`1` clears the key — the default stays the
 * default) and apply it to the scheduler. Resolves to the width the backend
 * actually applied, or `null` outside Tauri (browser preview). */
export async function setGpuMaxJobs(limit: number): Promise<number | null> {
  const clamped = Math.min(Math.max(Math.trunc(limit), 1), MAX_GPU_JOBS);
  try {
    if (clamped === 1) {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    } else {
      globalThis.localStorage.setItem(STORAGE_KEY, String(clamped));
    }
  } catch {
    /* persistence is best-effort */
  }
  return applyGpuMaxJobs(clamped);
}

/** Apply a width to the backend scheduler without touching the stored value.
 * Used on startup to re-apply the persisted setting. */
export async function applyGpuMaxJobs(limit: number): Promise<number | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return (await invoke("set_gpu_max_jobs", { limit })) as number;
}
