# System Model Manager Surface Plan

> Historical note (2026-07-16): local inference and downloadable-engine UI described below were retired. The current product keeps deterministic native operations and sends model-backed work through API profiles. Treat the remaining text as implementation history, not current guidance.


> Status: complete. Landed via PRs #393 (manager surface, registry, selector
> APIs), #394 (card API profile selection), and #395 (card local model
> selection).
> Purpose: define the system-level UI surface that owns API profiles and local
> model bindings, so card-level model dropdowns all read from one consistent
> source of truth.

## Core Decision

Model and API configuration is a system-level concern.

Cards must not each invent their own provider fields, model path fields, API key
fields, engine probes, or model lists. They should show compact dropdowns that
reference managed entries from one global manager.

The user-facing entry should be a global app-shell button:

```text
Models / APIs
```

Clicking it opens one system modal or settings panel with two primary tabs:

```text
Models / APIs
  API Profiles
  Local Models
```

The manager is the source of truth. If two cards show inconsistent model/API
choices for the same capability, that is a bug in the manager or selector
plumbing, not a card-level product decision.

## Why This Must Come Before Card Polish

Current card-level fields create a broken chain:

```text
card dropdown
  -> maybe provider text
  -> maybe model text
  -> maybe credentials_ref
  -> maybe local engine/device/precision
```

That cannot scale across image processing, prompt optimization, generation,
audio, video, and future model-assisted tools.

The correct chain is:

```text
System Model Manager
  -> managed API profiles and local model entries
  -> capability-filtered selectors
  -> card params store stable refs
  -> execution resolves refs at run time
```

## Modal Structure

### API Profiles Tab

Owns remote or local-server API profiles.

Minimum fields:

| Field | Purpose |
| --- | --- |
| `api_profile_ref` | Stable id stored by cards. |
| `display_name` | What users see in dropdowns. |
| `provider_kind` | OpenAI-compatible, Replicate, custom HTTP, etc. |
| `base_url` | Endpoint for provider or local server. |
| `credentials_ref` | Secret reference, never raw key in graph JSON. |
| `default_model` | Default model for this profile. |
| `known_models` | Manual or fetched model ids. |
| `capabilities` | Tasks this profile can run. |
| `health` | untested / valid / missing key / unreachable / capability mismatch. |

Required actions:

- add profile
- edit profile
- duplicate profile
- remove profile
- test connection manually
- fetch model list manually, when supported
- set default per capability

No API profile should be tested automatically on app startup.

### Local Models Tab

Owns local model entries, weights, runtime availability, and device defaults.

Minimum fields:

| Field | Purpose |
| --- | --- |
| `local_model_ref` | Stable id stored by cards. |
| `display_name` | What users see in dropdowns. |
| `capabilities` | Tasks this model can run. |
| `engine` | ONNX / ORT / native Rust / external service / future backend. |
| `weights_path` | Local path or managed cache ref. |
| `runtime_ref` | Runtime binding when relevant. |
| `device_policy` | auto / cpu / cuda / directml / future gpu policy. |
| `precision_policy` | auto / fp32 / fp16 where supported. |
| `health` | untested / installed / missing weights / unsupported runtime / device fallback. |
| `fallback_policy` | built-in / CPU / API fallback / no fallback. |

Required actions:

- add local model
- bind weights path
- import model metadata
- test model manually
- set default per capability
- show last device report
- show missing dependency reason

No local model folder scan or engine probe should run just because a card
dropdown opened.

## Capability Taxonomy

The manager owns capabilities, not cards.

Examples:

```ts
type ModelCapability =
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
```

Capabilities are not just labels. They control:

- which backend entries appear in a card dropdown
- whether a row can choose API / local / built-in
- whether required prompts or media inputs are missing
- whether execution can run
- what fallback is legal

## Stable Reference Contract

Cards store refs, not raw configuration:

```ts
type ManagedBackendRef =
  | { kind: "api_profile"; ref: string }
  | { kind: "local_model"; ref: string }
  | { kind: "built_in"; ref: string };
```

The manager resolves the ref at run time.

Graph JSON may store:

```text
api_profile_ref
local_model_ref
built_in_ref
backend_choice
```

Graph JSON must not store:

```text
raw API key
raw Bearer token
duplicated base URL per card
duplicated local weight path per row
random provider/model text fields as the primary path
```

Legacy fields may remain for loading old workflows, but new UI should write
manager refs first.

## Global Entry Points

Recommended entry points:

| Entry | Behavior |
| --- | --- |
| App shell button: `Models / APIs` | Opens the full manager modal. |
| Settings rail: `Models / APIs` | Opens the same modal. |
| Card dropdown: `Manage...` | Opens the manager filtered to the needed capability. |
| Missing backend warning | Opens the manager with the missing tab/entry highlighted. |

The manager should not live in the bottom production drawer. The drawer is for
Edit / Timeline and Grade.

## Card Dropdown Contract

Every card selector should be capability-filtered.

Example:

```text
Image Processing / Enhance row
  Run with: Local
  Model: [Local: RealESRGAN Fast v]
```

The dropdown only lists local models with:

```text
image.upscale or image.enhance
```

If the same model is missing from one card but appears in another card for the
same capability, that is a consistency bug.

## Health And Probing Rules

Use manual probes and per-run reports.

Allowed:

- user clicks `Test`
- user clicks `Refresh models`
- execution resolves a selected backend and reports actual device/fallback

Not allowed:

- app startup probes all local models
- opening a dropdown scans model folders
- mounting an inspector probes engines
- hidden UI warms every API profile

This keeps first launch fast and prevents UI panels from causing runtime stalls.

## Relationship To Other Plans

- [`API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md)
  defines the shared reference layer and execution resolution.
- [`NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md`](NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md)
  defines how cards and rows consume the manager through dropdowns.
- [`GPU_DEVICE_STRATEGY_PLAN.md`](../active/GPU_DEVICE_STRATEGY_PLAN.md) defines requested
  vs actual device reporting.
- [`PROMPT_ASSISTANT_SYSTEM_PLAN.md`](PROMPT_ASSISTANT_SYSTEM_PLAN.md) consumes
  the same backend refs for assistant conversations.

## Implementation Order

1. ✅ Add the global `Models / APIs` entry point (toolbar global row).
2. ✅ Add the manager shell modal with `API Profiles` and `Local Models` tabs
   (`studio-ui/src/models/ModelManagerModal.tsx`).
3. ✅ Add persistent refs and in-memory registry shape
   (`studio-ui/src/models/backendRegistry.ts`, persisted registry keyed by
   stable `ref`s; raw keys never stored).
4. ✅ Migrate API profile creation/edit/test into the API tab (add / edit /
   duplicate / remove, manual connection test, manual import of the existing
   H-Gripe provider profiles via `get_profiles`).
5. ✅ Migrate local model entries/path/test into the Local Models tab (weights
   path binding, device/precision/fallback policies, manual weights probe via
   the `probe_model_weights` command — desktop only).
6. ✅ Add capability-filtered selector API for cards (`apiProfilesFor` /
   `localModelsFor` / `backendsFor` / `resolveBackendRef`).
7. ✅ Update cards to use refs from selectors instead of raw provider/model
   fields (`studio-ui/src/models/BackendSelector.tsx`: capability-filtered
   dropdown in the inspector for `generate` / `promptOptimize` (api mode) /
   `detailRepaint`; selection stores `api_profile_ref` and mirrors legacy
   provider/model/credentials fields so existing executors keep working).
8. ✅ Keep legacy raw fields loadable behind advanced/debug compatibility
   (raw provider/model/credentials params carry `advanced: true` and render
   under an "Advanced / legacy fields" disclosure; saved workflows load
   unchanged).

## Success Criteria

The user can configure once:

```text
API Profiles:
  OpenAI-compatible image profile
  Custom local-server text profile

Local Models:
  RealESRGAN image upscale
  BiRefNet subject mask
  Whisper transcription
```

Then every card sees the same consistent dropdown options for the capabilities
it supports.

If a card cannot find the needed backend, the fix happens in the system manager,
not inside the card.
