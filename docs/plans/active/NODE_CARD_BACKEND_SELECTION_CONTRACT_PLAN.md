# Node Card Backend Selection Contract Plan

> Status: active.
> Purpose: define how production cards consume system-managed API/local model
> backends without turning the graph into a web of model configuration nodes.

## Core Decision

Production cards should not connect to a separate "model configuration" node for
normal image/audio/video processing rows.

Cards should reference system-managed backends through dropdowns populated by
the global model manager:

```text
System Model Manager
  -> API profiles
  -> Local models
  -> capability-filtered dropdowns inside cards
```

This keeps data flow lines for production media and prompt flow, while model/API
configuration stays consistent and centrally repairable.

## Two Different Concepts

Do not collapse these into one "model card" idea.

### Main Output Model Card

A main output model card creates a primary artifact from creative inputs.

It may accept:

- prompt
- image reference
- audio reference
- video reference
- style/reference assets

It outputs:

- generated image
- generated video
- generated audio
- text / transcript / structured result

This card is a production step, not a config object.

### Processing Card Backend Binding

A processing card such as `Image Processing` owns operation rows:

- Enhance
- Grade
- Crop
- Mask / Matte
- Repair / Repaint

Those rows may use built-in compute, API profiles, or local models. That choice
is a row setting backed by the system manager, not an external graph node.

## Card-Level Binding + Row-Level Choice

Processing cards may bind available backends at the card level:

```text
Image Processing Card
  API profile: [OpenAI Image Edit v]
  Local model group: [Local Image Toolkit v]
  Default run mode: [auto v]
```

Rows choose how to run:

```text
Enhance
  Run with: Built-in / Local / API / Auto
  Model/Profile: capability-filtered dropdown
  Prompt/Instruction: optional row field

Mask / Matte
  Run with: Built-in / Local / API / Auto
  Model/Profile: capability-filtered dropdown
  Prompt/Instruction: optional row field

Repair / Repaint
  Run with: Local / API / Auto
  Model/Profile: capability-filtered dropdown
  Prompt/Instruction: row field
```

The row does not store raw API keys, base URLs, or local model paths. It stores
refs selected from the manager.

## Image Processing Contract

The image processing card should not expose manual editing as row behavior.

Manual edit belongs upstream:

```text
Image Source / media asset
  -> open image editor
  -> confirm edited image
  -> feed edited image into Image Processing
```

`Image Processing` is for automatic or parameterized processing.

Recommended product shape:

```text
Inputs:
  image
  prompt optional

Card bindings:
  api_profile_ref optional
  local_model_ref optional
  default_backend_choice: auto | built_in | local | api

Rows:
  Layer Split
  Enhance
  Grade
  Crop / Transform
  Mask / Matte
  Repair / Repaint

Outputs:
  layered asset
  enhanced image
  graded image
  cropped image
  mask / cutout / alpha
  repaired image
  report outputs where needed
```

The left side should describe card-level inputs. The right side should expose
row-level results. Do not make the user connect the same input image to every
row just to use the card.

## Row Capability Contract

Each row declares what execution modes it supports.

Example:

| Row | Built-in | Local Capability | API Capability | Prompt Field |
| --- | --- | --- | --- | --- |
| Layer Split | yes | `mask.subject`, `layer.classify` | optional future | optional |
| Enhance | yes | `image.upscale`, `image.enhance` | `image.edit` / `image.enhance` | optional |
| Grade | yes, `hgripe-grade` | no default model | no default API | optional preset text only |
| Crop / Transform | yes | optional `image.crop.auto` | optional future | optional instruction |
| Mask / Matte | yes | `mask.subject`, `matte.refine` | `image.segment` / future | optional |
| Repair / Repaint | limited | `image.inpaint` | `image.edit`, `image.inpaint` | yes |

Rows must only show backend choices that match their capabilities.

If a row selects `Local`, the model dropdown filters to matching local models.
If it selects `API`, the profile dropdown filters to matching API profiles.
If it selects `Built-in`, no external model/profile dropdown is needed.

## Ambiguity Rules

### Enhance Means A Specific Operation

`Enhance` cannot be a vague button.

It must declare:

- target: the card input image
- operation: upscale / denoise / sharpen / restore detail / print-ready
- backend choice: built-in / local / API / auto
- params: scale, denoise, texture/detail, preserve text/logo, output format
- output: enhanced image

### Mask Means Automatic/Parameterized Output

Manual mask drawing does not live in the processing row.

The row may use:

- built-in deterministic mask/matte tools
- local subject/matte model
- API segmentation where configured

It may retain internal data such as edit paths for compatibility, but normal
manual authoring belongs in the image editor.

### Crop Means Automatic Or Parameterized Crop

Manual crop-box drawing belongs in the image editor or source asset edit flow.

The processing row may support:

- auto subject crop
- fixed aspect crop
- prompt/instruction-driven crop in future
- parameterized size/margin

### Repair Uses Row Prompt/Instruction

Repair/repaint is the row most likely to need prompt text.

Recommended fields:

```text
Repair prompt / instruction
Negative prompt optional
Strength
Region policy
Backend choice
Profile/model dropdown
```

The row may inherit a card-level prompt by default, but it should allow a row
override so one card can run different operations with different instructions.

## Main Output Model Card Contract

The main output model card is different from processing rows.

It accepts creative inputs:

```text
prompt
image reference
audio reference
video reference
style reference
```

It selects:

```text
task: image.generate | image.edit | audio.generate | audio.transcribe |
      video.generate | video.describe | multimodal.describe | ...
backend: API profile or local model from manager
```

It outputs a primary artifact.

It should not be used as the normal way to configure `Enhance`, `Mask`, `Crop`,
or `Repair` rows inside `Image Processing`.

## Data Consistency Rule

Every card dropdown must use the same manager API.

Good:

```text
row.supportedCapabilities
  -> query System Model Manager
  -> show matching refs
  -> store selected ref
```

Bad:

```text
Generate card has one provider list
Image Processing row has another provider list
Prompt Assistant has a third provider list
Local model paths typed into every node
```

Inconsistent options for the same capability are a bug.

## Runtime Contract

At execution:

```text
card row selected backend ref
  -> manager resolves backend
  -> row executor receives resolved backend and row params
  -> result reports requested/used backend and device
```

Reports should include:

```ts
type RowBackendReport = {
  requestedMode: "auto" | "built_in" | "local" | "api";
  resolvedMode: "built_in" | "local" | "api";
  backendRef?: string;
  capability: string;
  deviceReport?: unknown;
  fallbackReason?: string;
};
```

Fallback must be visible. If `Auto` chooses built-in because no local/API backend
matches, the report should say so.

## Migration Notes

Existing internal leaf nodes and parameters should not be deleted abruptly.

Keep them as implementation/backcompat:

- old workflows can load
- integrated cards can lower rows into existing leaf executors
- row params can remain namespaced
- model/API refs can be added alongside legacy `provider`, `model`, and
  `engine` fields

The product UI should move toward:

```text
one processing card
  -> card-level media input
  -> row-level operation settings
  -> manager-backed backend dropdowns
  -> row-level outputs
```

## Relationship To Other Plans

- [`SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md`](SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md)
  defines the global manager UI and two-tab source of truth.
- [`API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md)
  defines the reference and resolution layer.
- [`NODE_CARD_PRODUCT_BOUNDARY_PLAN.md`](NODE_CARD_PRODUCT_BOUNDARY_PLAN.md)
  defines which concepts are allowed to become visible node cards.

## Implementation Order

1. Build the system model manager surface first.
2. Add capability-filtered selector API.
3. Add card-level backend binding fields for `Image Processing`.
4. Add row-level `run_with` and model/profile dropdowns.
5. Add row-level prompt/instruction fields where needed.
6. Keep internal leaf lowering but route selected backend refs into row params.
7. Hide raw provider/model/path fields from normal card UI.
8. Add validation for missing or capability-incompatible refs.

## Success Criteria

The user can:

1. Open the global `Models / APIs` manager.
2. Bind API profiles and local models once.
3. Open `Image Processing`.
4. Choose row execution mode from consistent dropdowns.
5. Use Enhance with local, Mask with local, Repair with API, and Grade with
   built-in kernel without adding external model configuration nodes.
6. See a clear error if a selected backend does not support the row capability.

The graph stays readable, and model configuration becomes centralized instead
of duplicated across cards.
