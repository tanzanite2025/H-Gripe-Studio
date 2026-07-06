// Global default device preference (GPU_DEVICE_STRATEGY_PLAN long-term step
// 5, user controls): a settings surface, not a setup wizard. The preference
// only seeds the *default* `device` value where a node param or dialog leaves
// it unset — an explicit per-node `device` param always wins, and every
// request stays subject to the same probe/report/fallback paths, so a
// "prefer GPU" preference on a CPU-only machine degrades with a visible
// reason instead of failing.

export type DevicePreference = "auto" | "gpu" | "cpu";

export const DEVICE_PREFERENCES: DevicePreference[] = ["auto", "gpu", "cpu"];

export const DEVICE_PREFERENCE_KEY = "hgripe.devicePreference";

function isDevicePreference(value: unknown): value is DevicePreference {
  return value === "auto" || value === "gpu" || value === "cpu";
}

/** The stored global preference; `auto` when unset or unreadable (private
 * mode, corrupt value). */
export function getDevicePreference(): DevicePreference {
  try {
    const raw = globalThis.localStorage.getItem(DEVICE_PREFERENCE_KEY);
    return isDevicePreference(raw) ? raw : "auto";
  } catch {
    return "auto";
  }
}

/** Persist the global preference. `auto` clears the stored value so the
 * default stays the default. Storage failures are ignored — the preference
 * is a convenience, never required state. */
export function setDevicePreference(preference: DevicePreference): void {
  try {
    if (preference === "auto") {
      globalThis.localStorage.removeItem(DEVICE_PREFERENCE_KEY);
    } else {
      globalThis.localStorage.setItem(DEVICE_PREFERENCE_KEY, preference);
    }
  } catch {
    /* the preference is best-effort */
  }
}

/** The `device` value an unset param defaults to: the global preference.
 * Callers keep passing explicit params through untouched. */
export function defaultDeviceParam(): DevicePreference {
  return getDevicePreference();
}
