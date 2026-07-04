import { describe, expect, it } from "vitest";

import {
  apiProfilesFor,
  backendsFor,
  duplicateApiProfile,
  duplicateLocalModel,
  emptyRegistry,
  importLegacyProfiles,
  localModelsFor,
  parseRegistry,
  removeApiProfile,
  removeLocalModel,
  resolveBackendRef,
  uniqueRef,
  upsertApiProfile,
  upsertLocalModel,
  type ApiProfileEntry,
  type LocalModelEntry,
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

function localModel(overrides: Partial<LocalModelEntry> = {}): LocalModelEntry {
  return {
    ref: "sam2-base",
    display_name: "SAM2 base",
    capabilities: ["mask.subject"],
    engine: "onnx",
    weights_path: "C:/models/sam2.onnx",
    device_policy: "auto",
    precision_policy: "auto",
    health: "untested",
    fallback_policy: "built_in",
    health_detail: null,
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

  it("upserts, duplicates and removes local models", () => {
    let reg = upsertLocalModel(emptyRegistry(), localModel());
    reg = upsertLocalModel(reg, localModel({ engine: "ort" }));
    expect(reg.localModels).toHaveLength(1);
    expect(reg.localModels[0].engine).toBe("ort");

    reg = duplicateLocalModel(reg, "sam2-base");
    expect(reg.localModels).toHaveLength(2);

    reg = removeLocalModel(reg, "sam2-base");
    expect(reg.localModels.map((m) => m.ref)).toEqual(["sam2-base-copy"]);
  });

  it("generates collision-free refs", () => {
    const taken = [{ ref: "api-profile" }, { ref: "api-profile-2" }];
    expect(uniqueRef("API Profile", taken)).toBe("api-profile-3");
    expect(uniqueRef("", [])).toBe("entry");
  });
});

describe("capability-filtered selectors", () => {
  const reg = upsertLocalModel(
    upsertApiProfile(
      upsertApiProfile(emptyRegistry(), apiProfile()),
      apiProfile({ ref: "text-only", capabilities: ["text.generate"] }),
    ),
    localModel(),
  );

  it("filters API profiles and local models by capability", () => {
    expect(apiProfilesFor(reg, "image.generate").map((p) => p.ref)).toEqual(["openai-main"]);
    expect(apiProfilesFor(reg, "mask.subject")).toEqual([]);
    expect(localModelsFor(reg, "mask.subject").map((m) => m.ref)).toEqual(["sam2-base"]);
  });

  it("lists managed backends for one capability, API profiles first", () => {
    const withApiMask = upsertApiProfile(
      reg,
      apiProfile({ ref: "mask-api", capabilities: ["mask.subject"] }),
    );
    expect(backendsFor(withApiMask, "mask.subject").map((o) => o.ref)).toEqual([
      { kind: "api_profile", ref: "mask-api" },
      { kind: "local_model", ref: "sam2-base" },
    ]);
  });

  it("resolves stored refs and reports dangling ones as null", () => {
    expect(resolveBackendRef(reg, { kind: "api_profile", ref: "openai-main" })?.ref).toBe(
      "openai-main",
    );
    expect(resolveBackendRef(reg, { kind: "local_model", ref: "sam2-base" })?.ref).toBe(
      "sam2-base",
    );
    expect(resolveBackendRef(reg, { kind: "api_profile", ref: "gone" })).toBeNull();
    expect(resolveBackendRef(reg, { kind: "built_in", ref: "rules" })).toBeNull();
  });
});

describe("persistence parsing", () => {
  it("round-trips a registry through JSON", () => {
    const reg = upsertLocalModel(upsertApiProfile(emptyRegistry(), apiProfile()), localModel());
    expect(parseRegistry(JSON.parse(JSON.stringify(reg)))).toEqual(reg);
  });

  it("drops malformed entries and unknown capabilities", () => {
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
    expect(parsed.localModels).toHaveLength(1);
    expect(parsed.localModels[0].device_policy).toBe("auto");
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
