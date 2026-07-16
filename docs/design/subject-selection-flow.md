# Subject Selection Flow

Status: design note only. This document defines the boundary for a future
subject-selection feature so it does not become a half-wired image-editor-only
shortcut.

## Goal

Build subject selection as an independent reusable flow:

```text
source image/frame + user prompt region + selection mode/API profile + refine params
  -> subject mask / alpha mask
```

The flow can be opened from the image editor, a node card, or a video/clip
surface. It must not be owned by the layer panel, the marquee tool, crop, mask
preview, or selected-layer move code.

## Product Behavior

The user should not have to accept a full-image "best guess" subject. A single
image can contain multiple objects, so the subject must be guided.

Expected interaction:

1. User clicks Subject from an entry point.
2. A Subject Selection dialog opens.
3. User draws a prompt region on the image/frame, such as a rectangle or circle.
4. User adjusts refine values if needed.
5. User confirms.
6. The result is returned to the caller as a selection/mask result.

For the image editor, confirmation should show marching ants on the current
layer/document selection. It should not create a new layer and should not add a
layer mask. If the user wants a new layer, they can use the normal selection
workflow such as Ctrl+J after the selection looks correct.

## Non-Goals

- Do not create a layer automatically.
- Do not add a layer mask automatically.
- Do not make the toolbar icon call a no-op command.
- Do not reuse marquee/crop/selected-layer-move state for the prompt region.
- Do not mix API-profile configuration into the first UI pass.
- Do not bind the flow to only the image editor.

## Reusable Dialog Boundary

Subject Selection should behave like a plug-in inserted into a host surface. Its
state, cache, selection request, preview rendering, and failure handling must be
owned by the Subject Selection flow. If a deterministic operation fails or an
API request times out, returns invalid data, or clears its preview state, that
failure must not mutate or corrupt image-editor layers, marquee selections,
crop state, mask preview state, selected-layer move state, node state, or video
state.

The Subject Selection dialog owns:

- prompt shape state: rectangle, circle/ellipse, and future positive/negative
  prompt points
- preview mask state
- parameter draft state
- selection request state
- confirm/cancel state
- conversion from deterministic or API output to a caller-neutral result

The dialog receives:

- source image/frame pixels or a resolvable source reference
- initial viewport/frame metadata
- optional initial prompt region
- optional selection mode and API profile reference
- optional initial refine parameters

The dialog returns:

- alpha/selection mask dimensions
- mask data or a stable mask reference
- prompt metadata used to generate it
- refine parameters used
- cancellation without side effects

## Caller Responsibilities

Image editor:

- opens the dialog from the selected-layer context action
- passes the current layer/document image source
- receives the result as an `ActiveSelection`/selection mask
- displays marching ants
- leaves layer creation and mask creation to explicit user actions

Node card:

- opens the same dialog from a dedicated Subject Selection node/card
- keeps deterministic/API execution choices separate from this first dialog integration
- receives the result into node fields/outputs

Video/clip surface:

- opens the same dialog for a current frame or chosen frame
- receives the result as a clip/frame mask seed
- can later extend the result into tracking or per-frame mask generation

## Host Backfill Contract

Subject Selection is not owned by any one host. It returns a caller-neutral
`SubjectSelectionResult`; host-specific mutation is performed only by explicit
host adapters.

Shared contract names:

```text
SubjectSelectionResult
SubjectSelectionBackfillTarget
SubjectSelectionBackfillAdapter
backfillSubjectSelectionResultToHostTarget
```

Required host kinds:

```text
image_editor
node_canvas
video_clip
color_grade
```

Backfill capabilities:

```text
image_editor_active_selection
node_canvas_mask_input
video_clip_frame_mask_seed
color_grade_mask
```

Examples:

```text
image editor adapter:
  SubjectSelectionResult -> active selection / marching ants

node canvas adapter:
  SubjectSelectionResult -> node mask input or mask asset reference

video clip adapter:
  SubjectSelectionResult -> current-frame mask seed

color grade adapter:
  SubjectSelectionResult -> color-grade mask
```

The Subject Selection flow must never directly dispatch image-editor actions,
node-graph mutations, timeline mutations, or color-grade mutations. It may only
call a selected `SubjectSelectionBackfillAdapter`.

## Execution Boundary

API-profile choice is a separate concern from the first dialog flow.

Supported execution modes are:

- deterministic native selection
- a configured API profile that declares subject-selection capability

There is no internal-model, local-weight, or inference-runtime mode. A node card
may eventually expose a compact `Built-in` / `API profile` choice, but API
configuration must not be mixed into the initial image-editor toolbar work.

## Refinement Parameters

Initial useful parameters:

- confidence/threshold: how strong a selection score must be to become selected
- expand/contract: move the final boundary outward or inward
- smooth: reduce jagged edges and small contour noise
- feather: soften the final selection edge
- edge refine: future path for hair, fur, translucent material, and soft edges

These parameters should update a preview result in the dialog and only commit
when the user confirms.

## Architecture Rule

The prompt region is not the final selection. It is an input hint telling the
selected deterministic operation or API capability where to look. Therefore it
must be implemented as an independent subject-prompt interaction, not as normal
marquee selection state.

Only the confirmed result may be converted into the host surface's native
selection/mask representation.

Failure isolation is mandatory: host adapters may pass source references into
Subject Selection and may receive a confirmed result back, but they must not
share mutable runtime state or caches with the subject-selection internals.

## Suggested Module Split

```text
subjectSelection/
  SubjectSelectionDialog.tsx
  SubjectPromptCanvas.tsx
  subjectSelectionTypes.ts
  subjectSelectionParams.ts
  subjectSelectionPreviewCache.ts
  subjectSelectionClient.ts
```

Host adapters can live near their callers:

```text
imageEditorModal/useSubjectSelectionDialog.ts
nodes/SubjectSelectionNode.tsx
clip/useClipSubjectSelection.ts
```

The shared flow should stay independent of layer-panel UI, context-action UI,
marquee selection, crop, mask preview, and selected-layer move caches.
