# API And Local Model Management Plan

> Historical note (2026-07-16): local inference and downloadable-engine UI described below were retired. The current product keeps deterministic native operations and sends model-backed work through API profiles. Treat the remaining text as implementation history, not current guidance.


> Status: complete. Migration steps 1–8 landed (#393–#397, #522–#523): the
> managers, capability-filtered selectors, card refs, and the Prompt
> Assistant all consume `ModelBackendRef`. Kept as the reference contract for
> future model/API-consuming cards and capability rows.
> Purpose: define the shared configuration layer for API providers, credentials,
> model profiles, local model paths, capability checks, and card references.

## Core Decision

Cards should not own API configuration or local model installation details.

Cards should reference a managed profile:

```text
Generate card
  api_profile_ref: "openai-main"

Prompt Assistant
  backend_ref: "api:openai-main" or "local:prompt-small"

Image Processing row
  local_model_ref: "birefnet-matte"
```

The managers own the details:

- API Manager owns provider profiles, base URLs, credentials, model ids, and
  capabilities.
- Local Model Manager owns installed weights, model paths, engine availability,
  device/precision preferences, and fallback state.

This keeps graph cards clean and makes API/local model behavior consistent
across Prompt Assistant, Prompt card optimization, Generate, Image Processing,
repaint, masking, and future video/audio tools.

## Current State

The manager and card-selector foundation has landed:

- global `Models / APIs` manager surface exists
- persistent API profile and local model registries exist
- API profile selectors are capability-filtered
- local model selectors are capability-filtered
- `Image Processing` row backend refs are stored in row namespaced params
- legacy provider/model/credentials and engine fields remain loadable behind
  compatibility/advanced paths
- pre-run backend ref validation checks selected refs against the manager

Completed detail plans:

- [`SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md`](SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md)
- [`NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md`](NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md)
- [`PROMPT_ASSISTANT_SYSTEM_PLAN.md`](PROMPT_ASSISTANT_SYSTEM_PLAN.md) — the
  assistant and Prompt card optimization consume `ModelBackendRef`.

Standing guidance for future work:

- Future audio/video/model-assisted cards should use the same manager selectors.
- Backend/device reports should continue aligning with
  [`GPU_DEVICE_STRATEGY_PLAN.md`](../active/GPU_DEVICE_STRATEGY_PLAN.md).

## API Manager

API Manager is a global settings surface, not a node card.

It owns:

| Field | Purpose |
| --- | --- |
| `profile_ref` | Stable id referenced by graph cards and assistant sessions. |
| `provider` | Provider kind: OpenAI-compatible, Replicate, custom HTTP, etc. |
| `display_name` | User-facing name. |
| `base_url` | Endpoint for OpenAI-compatible or custom providers. |
| `credentials_ref` | Reference to stored secret, not the raw key. |
| `default_model` | Default model for this profile. |
| `model_list` | Known model ids or fetched provider model list. |
| `capabilities` | `text.generate`, `image.generate`, `image.edit`, etc. |
| `status` | valid / missing key / unreachable / capability mismatch. |

Cards reference `profile_ref`; execution resolves it into provider details at
run time.

## API Credential Rule

Raw API keys must not live in graph JSON.

Graph cards and assistant sessions may store:

```ts
type ApiProfileRef = string;
type CredentialsRef = string;
```

They must not store:

```text
sk-...
Bearer ...
raw key text
```

The API Manager may expose credential labels and status, but secrets should be
stored through the existing local credential mechanism or OS-backed storage when
available.

## API Capability Model

Every API profile should declare or discover capabilities:

```ts
type ApiCapability =
  | "text.generate"
  | "image.generate"
  | "image.edit"
  | "image.inpaint"
  | "vision.describe"
  | "embedding";
```

This matters because not every API model can do every task.

Examples:

- Prompt Assistant needs `text.generate`.
- Prompt card optimization needs `text.generate`.
- Generate needs `image.generate`.
- Detail Repaint provider path needs `image.edit` or `image.inpaint`.
- Future reference-image prompt drafting may need `vision.describe`.

The UI should prevent selecting a profile that cannot run the current task, or
show a clear warning before run.

## Local Model Manager

Local Model Manager is the shared surface for native/local model resources.

It owns:

| Field | Purpose |
| --- | --- |
| `model_ref` | Stable id referenced by cards and assistant. |
| `display_name` | User-facing name. |
| `task` | Prompt rewrite, mask, matting, upscale, inpaint, defect detect, etc. |
| `engine` | ONNX / ORT / native Rust / external command / future backend. |
| `weights_path` | Resolved weight path or managed cache entry. |
| `device_policy` | auto / cpu / cuda / future DirectML/Vulkan. |
| `precision_policy` | auto / fp32 / fp16 where applicable. |
| `capabilities` | What this local model can do. |
| `health` | installed / missing weights / missing runtime / incompatible device. |
| `fallback` | What happens when unavailable. |

The manager should make local availability obvious before a node run fails.

## Local Model Capability Model

Local models should declare task capability, not just engine name:

```ts
type LocalModelCapability =
  | "prompt.rewrite"
  | "vision.describe"
  | "mask.subject"
  | "matte.refine"
  | "image.upscale"
  | "image.inpaint"
  | "defect.detect"
  | "layer.classify";
```

This lets Prompt Assistant, Image Processing, and future model cards ask:

```text
Which local models can rewrite prompts?
Which local models can produce a subject mask?
Which local models can inpaint?
```

They should not hard-code a dropdown per card.

## Shared Reference Contract

Use stable refs in graph and assistant data:

```ts
type ModelBackendRef =
  | { kind: "api_profile"; ref: string }
  | { kind: "local_model"; ref: string };
```

Cards store references:

```ts
interface ApiBackedParams {
  api_profile_ref?: string;
  model_override?: string;
}

interface LocalBackedParams {
  local_model_ref?: string;
  device_override?: "auto" | "cpu" | "cuda";
  precision_override?: "auto" | "fp32" | "fp16";
}
```

Legacy params such as `provider`, `model`, and `credentials_ref` can remain for
compatibility, but new UI should move toward profile refs.

## UI Surfaces

Recommended entry points:

| Entry | Opens |
| --- | --- |
| Prompt Assistant backend selector -> Configure | API Manager or Local Model Manager. |
| Generate card profile selector -> Manage | API Manager filtered to image generation. |
| Prompt card Optimize row -> Manage | API Manager or Local Model Manager filtered to text generation / prompt rewrite. |
| Image Processing row model selector -> Manage | Local Model Manager filtered to the row task. |
| Settings rail -> Models / APIs | Full management pages. |

The managers can open as modal/settings panels from the right rail. They should
not live in the bottom production drawer.

## API Manager UI Shape

First version:

- list profiles
- add profile
- edit provider/base URL/model
- choose credential ref
- test connection
- show capability status
- set default profile for text / image generation

Later:

- fetch model list
- per-capability default model
- request log / diagnostics
- rate limit display
- import/export config without secrets

## Local Model Manager UI Shape

First version:

- list known local model slots
- show installed / missing status
- set weights path
- show model cache dir
- probe runtime availability
- show device availability
- choose default model per task

Later:

- download/import weights
- validate checksum
- model card metadata
- VRAM estimate
- performance benchmark
- per-project overrides

## Execution Rules

API execution:

```text
card api_profile_ref
  -> API Manager resolves profile
  -> credentials manager resolves secret at run time
  -> broker receives provider/model/capability-safe task
```

Local execution:

```text
card local_model_ref
  -> Local Model Manager resolves engine + weights + device policy
  -> kernel probes availability
  -> run or fallback with explicit telemetry
```

Fallback must be visible. Silent fallbacks are acceptable only when the node
report clearly records what happened.

## Relationship To Prompt Assistant

Prompt Assistant uses the same backend refs:

```text
Prompt Assistant backend:
  API profile with text.generate
  or
  local model with prompt.rewrite / text.generate capability
```

Assistant sessions should not store raw API settings. They store a backend ref
and can survive config changes.

## Relationship To Node Cards

Node cards should show compact selectors, not full config forms.

Good:

```text
API: OpenAI Main / gpt-image-1 [Manage]
Local: Subject Matte Fast [Manage]
```

Bad:

```text
provider text field
base URL text field
API key text field
model path text field
device flags
precision flags
all on every card
```

Detailed configuration belongs in managers.

## Migration Path

1. Keep existing `provider` / `model` / `credentials_ref` params working.
2. Add `api_profile_ref` as the preferred UI field for API cards.
3. Add `local_model_ref` as the preferred UI field for local/compute cards.
4. Teach ProfilePicker to return profile refs, not only copied provider/model
   strings.
5. Add API Manager surface for profiles and capability test.
6. Add Local Model Manager surface for paths/probes/defaults.
7. Update Prompt Assistant to consume `ModelBackendRef`.
8. Gradually hide raw provider/model/credentials fields behind advanced debug
   views.

## Non-Goals

- Do not put API keys in graph JSON.
- Do not duplicate API settings per node.
- Do not make every node scan local model folders.
- Do not make local model setup part of the bottom production drawer.
- Do not require local heavy models for first-run usability.

## Success Criteria

The user can:

1. Configure an API profile once.
2. Configure or verify local model slots once.
3. Use the same profile/model from Prompt Assistant, Prompt card optimization,
   Generate, Image Processing, and repaint flows.
4. See when a selected backend is missing capabilities.
5. Open old workflows that still use legacy provider/model params.

The system stays unified: cards reference capability-backed profiles; managers
own configuration.
