// Manual API-profile reachability checks shared by the manager and agent actions.

import type { ApiProfileEntry, ApiProfileHealth } from "./backendRegistry";

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
