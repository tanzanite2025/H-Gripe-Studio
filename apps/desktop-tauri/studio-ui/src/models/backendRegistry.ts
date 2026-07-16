// System model manager registry (docs/plans/active/SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md).
//
// API profiles are the only managed backends. Retired local-model fields in
// older persisted payloads are ignored when the registry is loaded.

/** Tasks a backend entry can run. The manager owns this taxonomy, not cards. */
export type ModelCapability =
  | "text.generate"
  | "prompt.rewrite"
  | "image.generate"
  | "image.edit"
  | "image.inpaint"
  | "image.upscale"
  | "image.enhance"
  | "mask.subject"
  | "matte.refine"
  | "image.crop.auto"
  | "vision.describe"
  | "layer.classify"
  | "audio.transcribe"
  | "audio.clean"
  | "audio.separate"
  | "audio.generate"
  | "video.describe"
  | "video.upscale"
  | "video.interpolate"
  | "video.caption";

export const MODEL_CAPABILITIES: ModelCapability[] = [
  "text.generate",
  "prompt.rewrite",
  "image.generate",
  "image.edit",
  "image.inpaint",
  "image.upscale",
  "image.enhance",
  "mask.subject",
  "matte.refine",
  "image.crop.auto",
  "vision.describe",
  "layer.classify",
  "audio.transcribe",
  "audio.clean",
  "audio.separate",
  "audio.generate",
  "video.describe",
  "video.upscale",
  "video.interpolate",
  "video.caption",
];

export type ApiProfileHealth =
  | "untested"
  | "valid"
  | "missing_key"
  | "unreachable"
  | "capability_mismatch";

export interface ApiProfileEntry {
  /** Stable id stored by cards (`api_profile_ref`). */
  ref: string;
  display_name: string;
  /** OpenAI-compatible, Replicate, custom HTTP, … */
  provider_kind: string;
  base_url: string;
  /** Secret reference — never a raw key. */
  credentials_ref: string;
  default_model: string;
  /** Manually entered or fetched model ids. */
  known_models: string[];
  capabilities: ModelCapability[];
  health: ApiProfileHealth;
}

/** What API-backed card params store instead of raw configuration. */
export type ManagedBackendRef = { kind: "api_profile"; ref: string };

export interface BackendRegistry {
  apiProfiles: ApiProfileEntry[];
}

const REGISTRY_KEY = "hgripe.studio.modelRegistry.v1";

export function emptyRegistry(): BackendRegistry {
  return { apiProfiles: [] };
}

function isCapability(v: unknown): v is ModelCapability {
  return typeof v === "string" && (MODEL_CAPABILITIES as string[]).includes(v);
}

function sanitizeApiProfile(raw: unknown): ApiProfileEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ref !== "string" || !o.ref) return null;
  return {
    ref: o.ref,
    display_name: typeof o.display_name === "string" ? o.display_name : o.ref,
    provider_kind: typeof o.provider_kind === "string" ? o.provider_kind : "",
    base_url: typeof o.base_url === "string" ? o.base_url : "",
    credentials_ref: typeof o.credentials_ref === "string" ? o.credentials_ref : "",
    default_model: typeof o.default_model === "string" ? o.default_model : "",
    known_models: Array.isArray(o.known_models)
      ? o.known_models.filter((m): m is string => typeof m === "string")
      : [],
    capabilities: Array.isArray(o.capabilities) ? o.capabilities.filter(isCapability) : [],
    health:
      o.health === "valid" ||
      o.health === "missing_key" ||
      o.health === "unreachable" ||
      o.health === "capability_mismatch"
        ? o.health
        : "untested",
  };
}

/** Parse a persisted registry payload; unknown and retired fields are dropped. */
export function parseRegistry(raw: unknown): BackendRegistry {
  if (!raw || typeof raw !== "object") return emptyRegistry();
  const o = raw as Record<string, unknown>;
  return {
    apiProfiles: Array.isArray(o.apiProfiles)
      ? o.apiProfiles
          .map(sanitizeApiProfile)
          .filter((p): p is ApiProfileEntry => p !== null)
      : [],
  };
}

export function loadRegistry(): BackendRegistry {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return emptyRegistry();
    return parseRegistry(JSON.parse(raw));
  } catch {
    return emptyRegistry();
  }
}

/** Fired on `window` after every registry save, so open selectors reload. */
export const REGISTRY_EVENT = "hgripe:model-registry";

export function saveRegistry(registry: BackendRegistry): void {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
  } catch {
    /* persistence is best-effort */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REGISTRY_EVENT));
}

/** A ref that does not collide with existing entries. */
export function uniqueRef(base: string, taken: Iterable<{ ref: string }>): string {
  const existing = new Set(Array.from(taken, (e) => e.ref));
  const slug = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = slug || "entry";
  if (!existing.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** Insert or replace the profile with the same ref. */
export function upsertApiProfile(
  registry: BackendRegistry,
  profile: ApiProfileEntry,
): BackendRegistry {
  const rest = registry.apiProfiles.filter((p) => p.ref !== profile.ref);
  return { ...registry, apiProfiles: [...rest, profile] };
}

export function removeApiProfile(registry: BackendRegistry, ref: string): BackendRegistry {
  return { ...registry, apiProfiles: registry.apiProfiles.filter((p) => p.ref !== ref) };
}

export function duplicateApiProfile(
  registry: BackendRegistry,
  ref: string,
): BackendRegistry {
  const source = registry.apiProfiles.find((p) => p.ref === ref);
  if (!source) return registry;
  const copyRef = uniqueRef(`${source.ref}-copy`, registry.apiProfiles);
  const copy: ApiProfileEntry = {
    ...source,
    ref: copyRef,
    display_name: `${source.display_name} (copy)`,
    health: "untested",
  };
  return { ...registry, apiProfiles: [...registry.apiProfiles, copy] };
}

// --- Capability-filtered selector API ----------------------------------------
// Only API profiles are selectable.

export function apiProfilesFor(
  registry: BackendRegistry,
  capability: ModelCapability,
): ApiProfileEntry[] {
  return registry.apiProfiles.filter((p) => p.capabilities.includes(capability));
}

export interface BackendOption {
  ref: ManagedBackendRef;
  label: string;
}

/** All selectable manager-backed choices for one capability. */
export function backendsFor(
  registry: BackendRegistry,
  capability: ModelCapability,
): BackendOption[] {
  return apiProfilesFor(registry, capability).map((profile) => ({
    ref: { kind: "api_profile" as const, ref: profile.ref },
    label: profile.display_name,
  }));
}

/** Resolve a selectable stored API profile ref. */
export function resolveBackendRef(
  registry: BackendRegistry,
  ref: ManagedBackendRef,
): ApiProfileEntry | null {
  return registry.apiProfiles.find((p) => p.ref === ref.ref) ?? null;
}

// --- Legacy import ------------------------------------------------------------
// Seed the registry from the existing H-Gripe provider profiles (the CLI/broker
// config the `get_profiles` command reads), so a configured box starts with
// its profiles listed instead of an empty manager.

export interface LegacyProviderProfile {
  profile_ref: string;
  provider?: string | null;
  model?: string | null;
  credentials_ref?: string | null;
}

export function importLegacyProfiles(
  registry: BackendRegistry,
  profiles: LegacyProviderProfile[],
): BackendRegistry {
  let next = registry;
  for (const legacy of profiles) {
    if (!legacy.profile_ref) continue;
    if (next.apiProfiles.some((p) => p.ref === legacy.profile_ref)) continue;
    next = upsertApiProfile(next, {
      ref: legacy.profile_ref,
      display_name: legacy.profile_ref,
      provider_kind: legacy.provider ?? "",
      base_url: "",
      credentials_ref: legacy.credentials_ref ?? "",
      default_model: legacy.model ?? "",
      known_models: legacy.model ? [legacy.model] : [],
      capabilities: [],
      health: "untested",
    });
  }
  return next;
}
