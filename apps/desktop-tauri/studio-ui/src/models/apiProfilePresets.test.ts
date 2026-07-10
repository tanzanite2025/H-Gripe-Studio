import { describe, expect, it } from "vitest";

import { API_PROFILE_PRESETS, profileFromPreset } from "./apiProfilePresets";
import { MODEL_CAPABILITIES, emptyRegistry, upsertApiProfile } from "./backendRegistry";

describe("API profile presets", () => {
  it("declares unique ids and only known capabilities", () => {
    const ids = API_PROFILE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of API_PROFILE_PRESETS) {
      expect(preset.base_url).toMatch(/^https:\/\//);
      for (const cap of preset.capabilities) {
        expect(MODEL_CAPABILITIES).toContain(cap);
      }
    }
  });

  it("materializes a profile with prefilled fields and untested health", () => {
    const preset = API_PROFILE_PRESETS[0];
    const profile = profileFromPreset(preset, emptyRegistry());
    expect(profile.ref).toBe(preset.id);
    expect(profile.base_url).toBe(preset.base_url);
    expect(profile.credentials_ref).toBe(preset.credentials_ref);
    expect(profile.health).toBe("untested");
  });

  it("avoids ref collisions when the preset was already added", () => {
    const preset = API_PROFILE_PRESETS[0];
    let registry = emptyRegistry();
    registry = upsertApiProfile(registry, profileFromPreset(preset, registry));
    const second = profileFromPreset(preset, registry);
    expect(second.ref).toBe(`${preset.id}-2`);
  });
});
