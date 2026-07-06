import { describe, expect, it } from "vitest";
import { beginGpuWork, isGpuBusy, subscribeGpuBusy, whenGpuIdle } from "./gpuLoad";

describe("gpuLoad", () => {
  it("is idle by default and busy while work is held", () => {
    expect(isGpuBusy()).toBe(false);
    const end = beginGpuWork();
    expect(isGpuBusy()).toBe(true);
    end();
    expect(isGpuBusy()).toBe(false);
  });

  it("composes overlapping work as a counter", () => {
    const a = beginGpuWork();
    const b = beginGpuWork();
    a();
    expect(isGpuBusy()).toBe(true);
    b();
    expect(isGpuBusy()).toBe(false);
  });

  it("ignores double-disposal", () => {
    const a = beginGpuWork();
    a();
    a();
    expect(isGpuBusy()).toBe(false);
  });

  it("notifies only on busy/idle flips", () => {
    let calls = 0;
    const unsub = subscribeGpuBusy(() => {
      calls += 1;
    });
    const a = beginGpuWork();
    const b = beginGpuWork();
    expect(calls).toBe(1);
    a();
    b();
    expect(calls).toBe(2);
    unsub();
  });

  it("whenGpuIdle resolves immediately when idle", async () => {
    await expect(whenGpuIdle()).resolves.toBeUndefined();
  });

  it("whenGpuIdle waits for in-flight work to end", async () => {
    const end = beginGpuWork();
    let resolved = false;
    const p = whenGpuIdle().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    end();
    await p;
    expect(resolved).toBe(true);
  });
});
