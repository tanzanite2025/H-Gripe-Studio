// Built-in API provider presets for the system model manager: one-click cards
// that prefill everything except the credential, so adding GPT / Gemini /
// RunningHub is "pick a card, paste your key reference, save". Presets are
// templates only — they never write to the registry by themselves.

import {
  uniqueRef,
  type ApiProfileEntry,
  type BackendRegistry,
  type ModelCapability,
} from "./backendRegistry";

export interface ApiProfilePreset {
  /** Stable preset id; also the stem for the created profile ref. */
  id: string;
  display_name: string;
  provider_kind: string;
  base_url: string;
  /** Suggested secret reference name the user binds their key to. */
  credentials_ref: string;
  default_model: string;
  known_models: string[];
  capabilities: ModelCapability[];
}

export const API_PROFILE_PRESETS: ApiProfilePreset[] = [
  {
    id: "openai",
    display_name: "OpenAI (GPT)",
    provider_kind: "openai-compatible",
    base_url: "https://api.openai.com/v1",
    credentials_ref: "openai-api-key",
    default_model: "gpt-4o",
    known_models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-image-1"],
    capabilities: [
      "text.generate",
      "prompt.rewrite",
      "vision.describe",
      "image.generate",
      "image.edit",
      "audio.transcribe",
    ],
  },
  {
    id: "gemini",
    display_name: "Google Gemini",
    provider_kind: "openai-compatible",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    credentials_ref: "gemini-api-key",
    default_model: "gemini-2.5-flash",
    known_models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    capabilities: ["text.generate", "prompt.rewrite", "vision.describe", "video.describe"],
  },
  {
    id: "runninghub",
    display_name: "RunningHub",
    provider_kind: "runninghub",
    base_url: "https://www.runninghub.ai",
    credentials_ref: "runninghub-api-key",
    default_model: "",
    known_models: [],
    capabilities: ["image.generate", "image.edit", "image.upscale", "video.upscale"],
  },
  {
    id: "anthropic",
    display_name: "Anthropic (Claude)",
    provider_kind: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    credentials_ref: "anthropic-api-key",
    default_model: "claude-sonnet-4-5",
    known_models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    capabilities: ["text.generate", "prompt.rewrite", "vision.describe"],
  },
  {
    id: "openrouter",
    display_name: "OpenRouter",
    provider_kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    credentials_ref: "openrouter-api-key",
    default_model: "",
    known_models: [],
    capabilities: ["text.generate", "prompt.rewrite", "vision.describe"],
  },
];

/** Materialize a preset into a fresh profile with a non-colliding ref. */
export function profileFromPreset(
  preset: ApiProfilePreset,
  registry: BackendRegistry,
): ApiProfileEntry {
  return {
    ref: uniqueRef(preset.id, registry.apiProfiles),
    display_name: preset.display_name,
    provider_kind: preset.provider_kind,
    base_url: preset.base_url,
    credentials_ref: preset.credentials_ref,
    default_model: preset.default_model,
    known_models: [...preset.known_models],
    capabilities: [...preset.capabilities],
    health: "untested",
  };
}
