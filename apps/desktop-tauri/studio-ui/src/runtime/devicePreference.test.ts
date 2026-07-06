// The global default device preference (GPU plan long-term step 5): a stored
// convenience that only seeds unset `device` params.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_PREFERENCE_KEY,
  defaultDeviceParam,
  getDevicePreference,
  setDevicePreference,
} from "./devicePreference";

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

describe("devicePreference", () => {
  it("defaults to auto when unset", () => {
    expect(getDevicePreference()).toBe("auto");
    expect(defaultDeviceParam()).toBe("auto");
  });

  it("round-trips gpu and cpu preferences", () => {
    setDevicePreference("gpu");
    expect(getDevicePreference()).toBe("gpu");
    expect(defaultDeviceParam()).toBe("gpu");

    setDevicePreference("cpu");
    expect(getDevicePreference()).toBe("cpu");
  });

  it("auto clears the stored value", () => {
    setDevicePreference("gpu");
    setDevicePreference("auto");
    expect(globalThis.localStorage.getItem(DEVICE_PREFERENCE_KEY)).toBeNull();
    expect(getDevicePreference()).toBe("auto");
  });

  it("treats a corrupt stored value as auto", () => {
    globalThis.localStorage.setItem(DEVICE_PREFERENCE_KEY, "quantum");
    expect(getDevicePreference()).toBe("auto");
  });

  it("survives a missing storage backend", () => {
    vi.unstubAllGlobals();
    expect(getDevicePreference()).toBe("auto");
    expect(() => setDevicePreference("gpu")).not.toThrow();
  });
});
