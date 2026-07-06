// The stored GPU lane width (GPU plan long-term step 5, "max concurrent GPU
// jobs"): a clamped convenience the scheduler is asked to apply.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGpuMaxJobs, setGpuMaxJobs, MAX_GPU_JOBS } from "./scheduler";

const STORAGE_KEY = "hgripe.gpuMaxJobs";

/** Map-backed localStorage for the node test environment. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gpuMaxJobs", () => {
  it("defaults to 1 when unset", () => {
    expect(getGpuMaxJobs()).toBe(1);
  });

  it("round-trips a stored width (outside Tauri the apply resolves null)", async () => {
    await expect(setGpuMaxJobs(3)).resolves.toBeNull();
    expect(getGpuMaxJobs()).toBe(3);
  });

  it("clamps out-of-range widths and clears the key at 1", async () => {
    await setGpuMaxJobs(99);
    expect(getGpuMaxJobs()).toBe(MAX_GPU_JOBS);
    await setGpuMaxJobs(0);
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getGpuMaxJobs()).toBe(1);
  });

  it("treats a corrupt stored value as 1", () => {
    globalThis.localStorage.setItem(STORAGE_KEY, "many");
    expect(getGpuMaxJobs()).toBe(1);
  });
});
