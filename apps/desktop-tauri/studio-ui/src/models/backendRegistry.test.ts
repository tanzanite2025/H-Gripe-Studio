import { describe, expect, it } from "vitest";

import {
  apiProfilesFor,
  backendsFor,
  duplicateApiProfile,
  emptyRegistry,
  importLegacyProfiles,
  parseRegistry,
  removeApiProfile,
  resolveBackendRef,
  uniqueRef,
  upsertApiProfile,
  type ApiProfileEntry,
} from "./backendRegistry";

function apiProfile(overrides: Partial<ApiProfileEntry> = {}): ApiProfileEntry {
  return {
    ref: "openai-main",
    display_name: "OpenAI main",
    provider_kind: "openai-compatible",
    base_url: "https://api.example.com/v1",
    credentials_ref: "openai-key",
    default_model: "gpt-image-1",
    known_models: ["gpt-image-1"],
    capabilities: ["image.generate", "image.edit"],
    health: "untested",
    ...overrides,
  };
}

describe("backendRegistry CRUD", () => {
  it("upserts, duplicates and removes API profiles", () => {
    let reg = upsertApiProfile(emptyRegistry(), apiProfile());
    expect(reg.apiProfiles).toHaveLength(1);

    // Upsert with the same ref replaces, not appends.
    reg = upsertApiProfile(reg, apiProfile({ display_name: "renamed" }));
    expect(reg.apiProfiles).toHaveLength(1);
    expect(reg.apiProfiles[0].display_name).toBe("renamed");

    reg = duplicateApiProfile(reg, "openai-main");
    expect(reg.apiProfiles).toHaveLength(2);
    const copy = reg.apiProfiles.find((p) => p.ref !== "openai-main")!;
    expect(copy.ref).toBe("openai-main-copy");
    expect(copy.health).toBe("untested");

    reg = removeApiProfile(reg, "openai-main");
    expect(reg.apiProfiles.map((p) => p.ref)).toEqual(["openai-main-copy"]);
  });

  it("generates collision-free refs", () => {
    const taken = [{ ref: "api-profile" }, { ref: "api-profile-2" }];
    expect(uniqueRef("API Profile", taken)).toBe("api-profile-3");
    expect(uniqueRef("", [])).toBe("entry");
  });
});

describe("capability-filtered selectors", () => {
  const reg = upsertApiProfile(
    upsertApiProfile(emptyRegistry(), apiProfile()),
    apiProfile({ ref: "text-only", capabilities: ["text.generate"] }),
  );

  it("filters API profiles by capability", () => {
    expect(apiProfilesFor(reg, "image.generate").map((p) => p.ref)).toEqual(["openai-main"]);
    expect(apiProfilesFor(reg, "mask.subject")).toEqual([]);
  });

  it("lists only API profiles as managed backend choices", () => {
    const withApiMask = upsertApiProfile(
      reg,
      apiProfile({ ref: "mask-api", capabilities: ["mask.subject"] }),
    );
    expect(backendsFor(withApiMask, "mask.subject").map((o) => o.ref)).toEqual([
      { kind: "api_profile", ref: "mask-api" },
    ]);
  });

  it("resolves stored refs and reports dangling ones as null", () => {
    expect(resolveBackendRef(reg, { kind: "api_profile", ref: "openai-main" })?.ref).toBe(
      "openai-main",
    );
    expect(resolveBackendRef(reg, { kind: "api_profile", ref: "gone" })).toBeNull();
  });
});

describe("persistence parsing", () => {
  it("round-trips a registry through JSON", () => {
    const reg = upsertApiProfile(emptyRegistry(), apiProfile());
    expect(parseRegistry(JSON.parse(JSON.stringify(reg)))).toEqual(reg);
  });

  it("drops malformed entries, unknown capabilities, and retired local models", () => {
    const parsed = parseRegistry({
      apiProfiles: [
        { ref: "ok", capabilities: ["image.generate", "not.a.capability"], health: "nonsense" },
        { display_name: "no ref" },
        null,
      ],
      localModels: [{ ref: "m", device_policy: "quantum" }, 42],
    });
    expect(parsed.apiProfiles).toHaveLength(1);
    expect(parsed.apiProfiles[0].capabilities).toEqual(["image.generate"]);
    expect(parsed.apiProfiles[0].health).toBe("untested");
    expect(Object.keys(parsed)).toEqual(["apiProfiles"]);
  });

  it("returns an empty registry for garbage payloads", () => {
    expect(parseRegistry(null)).toEqual(emptyRegistry());
    expect(parseRegistry("nope")).toEqual(emptyRegistry());
  });
});

describe("legacy profile import", () => {
  it("seeds entries from provider profile summaries without overwriting", () => {
    const existing = upsertApiProfile(
      emptyRegistry(),
      apiProfile({ ref: "openai-main", display_name: "kept" }),
    );
    const next = importLegacyProfiles(existing, [
      { profile_ref: "openai-main", provider: "openai", model: "other" },
      { profile_ref: "replicate", provider: "replicate", model: "sdxl", credentials_ref: "rep-key" },
      { profile_ref: "" },
    ]);
    expect(next.apiProfiles).toHaveLength(2);
    expect(next.apiProfiles.find((p) => p.ref === "openai-main")?.display_name).toBe("kept");
    const imported = next.apiProfiles.find((p) => p.ref === "replicate")!;
    expect(imported.provider_kind).toBe("replicate");
    expect(imported.default_model).toBe("sdxl");
    expect(imported.known_models).toEqual(["sdxl"]);
    expect(imported.credentials_ref).toBe("rep-key");
    expect(imported.health).toBe("untested");
  });
});
