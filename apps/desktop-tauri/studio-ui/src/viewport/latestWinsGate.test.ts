// The latest-wins preview gate (GPU queue policy): at most one render in
// flight and one queued; a superseded queued request resolves null without
// ever dispatching.

import { describe, expect, it } from "vitest";
import { latestWinsGate } from "./useGradeViewport";

/** A render whose completion the test controls. */
function deferredRender() {
  const calls: number[] = [];
  let release: (() => void)[] = [];
  const run = (id: number): Promise<number | null> => {
    calls.push(id);
    return new Promise((resolve) => {
      release.push(() => resolve(id));
    });
  };
  const releaseNext = () => {
    const next = release.shift();
    if (next) next();
  };
  return { run, calls, releaseNext };
}

describe("latestWinsGate", () => {
  it("dispatches immediately when idle", async () => {
    const { run, calls, releaseNext } = deferredRender();
    const gated = latestWinsGate(run);
    const p = gated(1);
    expect(calls).toEqual([1]);
    releaseNext();
    await expect(p).resolves.toBe(1);
  });

  it("queues one request while busy and supersedes older queued ones", async () => {
    const { run, calls, releaseNext } = deferredRender();
    const gated = latestWinsGate(run);
    const first = gated(1);
    const second = gated(2);
    const third = gated(3);
    // Only the first dispatched; the second was superseded by the third
    // before ever reaching the render.
    expect(calls).toEqual([1]);
    await expect(second).resolves.toBeNull();

    releaseNext(); // finish 1 — the queued newest (3) dispatches
    await expect(first).resolves.toBe(1);
    expect(calls).toEqual([1, 3]);
    releaseNext();
    await expect(third).resolves.toBe(3);
  });

  it("recovers after a rejected render", async () => {
    let fail = true;
    const gated = latestWinsGate((id: number): Promise<number | null> => {
      if (fail) return Promise.reject(new Error("render failed"));
      return Promise.resolve(id);
    });
    await expect(gated(1)).rejects.toThrow(/render failed/);
    fail = false;
    // The gate is free again: the next request dispatches and resolves.
    await expect(gated(2)).resolves.toBe(2);
  });
});
