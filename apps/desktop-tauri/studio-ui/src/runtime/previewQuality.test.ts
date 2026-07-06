// The preview speed vs export fidelity preference (GPU plan long-term step
// 5): a stored convenience that only picks the grade preview proxy size.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_QUALITY_KEY,
  getPreviewQuality,
  previewProxyMaxDim,
  setPreviewQuality,
} from "./previewQuality";

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

describe("previewQuality", () => {
  it("defaults to speed with the historical proxy size", () => {
    expect(getPreviewQuality()).toBe("speed");
    expect(previewProxyMaxDim()).toBe(1280);
  });

  it("round-trips fidelity and widens the proxy", () => {
    setPreviewQuality("fidelity");
    expect(getPreviewQuality()).toBe("fidelity");
    expect(previewProxyMaxDim()).toBe(2560);
  });

  it("speed clears the stored value", () => {
    setPreviewQuality("fidelity");
    setPreviewQuality("speed");
    expect(globalThis.localStorage.getItem(PREVIEW_QUALITY_KEY)).toBeNull();
    expect(getPreviewQuality()).toBe("speed");
  });

  it("treats a corrupt stored value as speed", () => {
    globalThis.localStorage.setItem(PREVIEW_QUALITY_KEY, "ludicrous");
    expect(getPreviewQuality()).toBe("speed");
  });

  it("survives a missing storage backend", () => {
    vi.unstubAllGlobals();
    expect(getPreviewQuality()).toBe("speed");
    expect(() => setPreviewQuality("fidelity")).not.toThrow();
  });
});
