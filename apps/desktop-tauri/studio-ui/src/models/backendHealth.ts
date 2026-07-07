// Backend health checks, extracted from the Model Manager's manual test
// buttons so the manager UI and the Model/API agent actions run one
// implementation. A raw key is never involved: the API test only checks
// reachability of the profile's base URL (credentials stay behind their
// secret ref), and the local test only checks weights presence via the
// backend. Checks are manual/on-demand only — nothing here runs on startup.

import { tauriInvoke } from "../bridge/core";
import type { ApiProfileEntry, ApiProfileHealth, LocalModelEntry, LocalModelHealth } from "./backendRegistry";

export type ApiHealthOutcome = "no_base_url" | "reachable" | "unreachable";

export interface ApiHealthResult {
  outcome: ApiHealthOutcome;
  health: ApiProfileHealth;
}

/** Reachability of the profile's base URL (8s timeout, GET, no credentials). */
export async function testApiProfileHealth(profile: ApiProfileEntry): Promise<ApiHealthResult> {
  const hasKey = profile.credentials_ref.trim() !== "";
  if (!profile.base_url.trim()) {
    return { outcome: "no_base_url", health: hasKey ? "untested" : "missing_key" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(profile.base_url, { method: "GET", signal: controller.signal });
    return { outcome: "reachable", health: hasKey ? "valid" : "missing_key" };
  } catch {
    return { outcome: "unreachable", health: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export type LocalHealthOutcome =
  | "no_weights_path"
  | "weights_found"
  | "weights_missing"
  | "desktop_only"
  | "probe_error";

export interface LocalHealthResult {
  outcome: LocalHealthOutcome;
  /** The entry's next health; `null` when the check could not run at all. */
  health: LocalModelHealth | null;
  detail: string | null;
}

/** Weights presence via the backend's `probe_model_weights` (desktop only). */
export async function probeLocalModelHealth(model: LocalModelEntry): Promise<LocalHealthResult> {
  if (!model.weights_path.trim()) {
    return { outcome: "no_weights_path", health: "missing_weights", detail: "no weights path" };
  }
  const invoke = tauriInvoke();
  if (!invoke) return { outcome: "desktop_only", health: null, detail: null };
  try {
    const present = await invoke("probe_model_weights", { path: model.weights_path });
    return present
      ? { outcome: "weights_found", health: "installed", detail: null }
      : { outcome: "weights_missing", health: "missing_weights", detail: model.weights_path };
  } catch (err) {
    return { outcome: "probe_error", health: "untested", detail: String(err) };
  }
}
