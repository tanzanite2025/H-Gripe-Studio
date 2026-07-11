# Mask Layer Target And Studio Action Plan

> Status: active planning document.
> Purpose: define the required mask/layer target model before building
> Studio Action or any AI-agent-driven quick operation path.
> Read with:
> [`IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md),
> which defines when a drawn solid selection draft becomes an addressable
> active selection target.

## Hard Gate

Do not build the Studio Action agent chain until the image editor layer and layer-mask
semantics are aligned with the Photoshop-style model.

The current risk is that "mask" actions can be interpreted as "create a new
layer." That is not stable enough for an AI action layer. A user command such
as "use SAM 2 to select this object and soften the edge" must resolve to a
specific target:

```text
canvas -> document -> layer -> layer mask / selection / path / node output
```

If the target resolver cannot tell whether the user means a pixel layer, a
layer mask, a selection, or a graph node output, the agent will produce
apparently random edits even when the model understood the text correctly.

## Core Decision

Layer masks must be represented as attachments/targets on a layer, not as
ordinary sibling layers.

The layer row should follow the Photoshop mental model:

```text
visibility | pixel thumbnail | link toggle | mask thumbnail | layer name | row actions
```

The screenshot reference shows the important idea:

```text
[eye] [image thumbnail] [link] [mask thumbnail] [Layer 0]
```

This means:

- clicking the pixel thumbnail activates the pixel/edit target;
- clicking the mask thumbnail activates the layer-mask target;
- the link control means the pixel content and mask move together or separately;
- creating a layer mask attaches it to the selected layer;
- creating a new layer remains a different command;
- deleting/disabling/applying a mask affects the mask attachment, not the layer
  itself unless the user explicitly chooses that destructive operation.

This distinction is mandatory before Studio Action, because every action needs
a stable `target`.

## Why This Must Come Before Studio Action

Studio Action will eventually let an assistant/API/local model call internal
editing operations. That is powerful only if every operation is target-safe.

Bad path:

```text
AI intent -> click UI / create mystery layer / mutate current modal state
```

Correct path:

```text
AI intent
  -> action schema
  -> target resolver
  -> dry run / preview
  -> commit as edit op
  -> undoable history
```

The action chain must not depend on UI automation. It should call internal
actions such as `create_layer_mask`, `run_sam2_prompt_mask`, `feather_mask`,
or `commit_selection_to_mask`.

## Software-Level Preview And Editor Entries

The canvas may trigger image preview or image editing, but neither surface
belongs inside the canvas node layer.

There are two product entry points over the same kernel/action layer:

| Surface | Role | Ownership |
| --- | --- | --- |
| Image preview modal | Fast review, compare, quick operation preview, and accept / rerun / open editor decisions. | Software-level modal launched from a node result, asset, layer, or graph output. |
| Image editor | Full document editing: layers, masks, paths, selections, history, and precise correction. | Software-level editor surface opened on demand from an image card, preview, asset, or layer target. |

Both entries must call the same lower layer:

```text
crop / transform
mask / matte
grade / adjust
selection / path
resize / repair / inpaint
  -> Studio Action
  -> compute block / Rust-WGPU kernel / model backend
  -> preview artifact
  -> commit transaction
```

This means the preview modal may expose quick crop, quick mask, quick grade, or
quick matte affordances, but those controls are only thin requests into the
shared action layer. The full image editor may expose the same operations with
more detailed UI and history, but it must not own a second implementation.

The canvas passes references, not editor logic:

```text
assetId
sourceNodeId
node_output target
layerId
layer_mask target
selectionId / pathId
operationContext
```

If a preview operation needs manual correction, the preview opens the image
editor with the same resolved target and draft artifact. If the editor commits,
the result returns as a traceable image/layer/selection-alpha artifact, not as
an invisible mutation of the canvas node.

Non-negotiable rules:

- do not put the full image editor inside a node card;
- do not make preview into a second mask-only editor with duplicated state;
- do not create crop/mask/grade tab stacks inside preview when the image editor
  already owns detailed editing;
- do not run expensive compute merely because the preview modal opens;
- only run compute after the user requests preview/apply or the graph run scope
  explicitly reaches that operation.

## Target Vocabulary

The editor needs first-class target ids. These ids are the language shared by
manual tools, compute blocks, graph rows, and future agent actions.

```ts
type StudioTarget =
  | { kind: "document"; canvasId: string; documentId: string }
  | { kind: "pixel_layer"; canvasId: string; documentId: string; layerId: string }
  | { kind: "layer_mask"; canvasId: string; documentId: string; layerId: string; maskId: string }
  | { kind: "selection"; canvasId: string; documentId: string; selectionId: string }
  | { kind: "path"; canvasId: string; documentId: string; pathId: string }
  | { kind: "node_output"; canvasId: string; nodeId: string; portId: string };
```

Important rule:

```text
selection != layer mask != pixel layer != node output
```

They may convert into each other, but they are not the same thing.

Examples:

- a pen path can create a selection only after an explicit Make Selection /
  commit step;
- a selection can become a layer mask;
- SAM 2 can produce a selection-alpha artifact from points/box/path hints;
- a selection-alpha artifact can be converted or attached to a layer mask target;
- a node output can open in the image editor, then be edited into a document.

Important distinction: a solid pen/lasso/marquee draft is not a `selection`
target yet. It is a `SelectionDraft` under
[`IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md).
Only the committed marching-ants state may receive a `selectionId`.

## PS-Aligned Mask Model

### Layer Row

Every visual layer row should reserve slots:

```text
eye | content thumb | link | mask thumb | name | badges/actions
```

When no mask exists, the mask slot may show an empty/add-mask affordance, but
the slot should remain reserved so rows do not jump.

### Active Target

The row needs a clear active-target state:

| Active target | Meaning |
| --- | --- |
| Pixel thumbnail active | Brush/adjustments/edit ops affect pixel content or pixel edit stack. |
| Mask thumbnail active | Brush/pen/SAM/matte ops affect the layer mask. |
| Selection active | Commands modify the committed floating selection, not yet a layer mask. Tool pointer handlers create drafts first; they do not mutate this state until Make Selection commits. |
| Path active | Anchor/path editing modifies vector path data. |

Do not infer target only from the last clicked tool. The document must store
the current target explicitly.

### Mask Commands

Commands should be separated:

| Command | Result |
| --- | --- |
| Add layer mask | Attach an empty/revealing/hiding mask to the active layer. |
| Generate mask from selection | Create or replace the active layer's mask from selection. |
| Apply mask | Destructively apply alpha/mask to pixels; should require confirmation. |
| Disable mask | Temporarily bypass mask, keep data. |
| Delete mask | Remove mask attachment only. |
| New layer | Create a new pixel/adjustment layer, unrelated to mask creation. |

This prevents the current "click mask -> new layer appears" confusion from
becoming a permanent product rule.

## Canvas Target Overlay And Context Commands

Selecting a layer in the layer panel must become a real editor target, not only
a highlighted row in the right rail.

The user needs an immediate answer to:

```text
What object will the next command affect?
```

For image editing this answer must be visible on the canvas and reflected in
the available commands. The correct architecture is not to patch a dashed box
or a floating toolbar into `LayersPanel`. The correct architecture is:

```text
active target
  -> target bounds
  -> overlay scene
  -> command capabilities
  -> context action bar / right rail / context menu / shortcuts
```

Every surface should read from the same target and command model. Otherwise
the editor will drift into conflicting behavior where a command is available
from one menu, hidden from another, and implemented differently in a floating
panel.

### Target Feedback On Canvas

When a layer, mask, selection, or path is active, the canvas should be able to
show a lightweight target overlay.

Suggested visual states:

| State | Canvas feedback | Purpose |
| --- | --- | --- |
| Layer selected, no transform tool | Low-emphasis dashed or hairline bounds. | Confirms which layer/object is active without making the canvas noisy. |
| Move/transform tool active | Solid transform frame with handles and rotation affordance. | Indicates direct manipulation is available. |
| Mask target active | Bounds/tint should indicate the mask attachment, not the pixel layer. | Prevents editing pixel content by mistake. |
| Selection active | Marching ants remain the primary overlay. | Selection is a floating edit constraint, not a layer. |
| Path active | Anchors and path outline are shown. | Path can be edited or converted. |
| Multiple layers selected | Combined bounds plus multi-select state in the layer panel. | Commands apply to a target set. |

The selected layer should not always show full transform handles. Handles mean
"you are transforming this object now." A quiet target outline means "this is
the active object."

### Bounds Must Be First-Class

Do not treat every target as the document rectangle. The editor needs separate
bound types:

```text
document bounds
layer frame
content bounds
mask bounds
selection bounds
path bounds
node-output bounds
timeline-clip frame bounds
```

This distinction matters immediately:

- a full-size image layer may contain a small visible object;
- a mask may hide most of a layer;
- a selection may cover only part of the active layer;
- a PSD layer may carry its own offset and trimmed pixel bounds;
- a node output preview may return an image artifact with no editor layer yet;
- a video frame target may share the same editor tools but live in a timeline
  context.

Suggested API shape:

```ts
type TargetBounds =
  | { kind: "none" }
  | { kind: "document"; rect: Rect }
  | { kind: "layer_frame"; rect: Rect; layerId: string }
  | { kind: "content"; rect: Rect; layerId: string; source: "alpha" | "ops" | "asset" }
  | { kind: "mask"; rect: Rect; layerId: string; maskId: string }
  | { kind: "selection"; rect: Rect; selectionId: string }
  | { kind: "path"; rect: Rect; pathId: string };
```

The bounds resolver must be pure and testable. It should not read DOM geometry
or panel state. Canvas placement converts document-space bounds into screen
coordinates later.

### Overlay Scene Ownership

All canvas outlines should come from one overlay scene builder:

```text
document state + active target + active tool + draft state
  -> overlay scene
  -> renderer
```

Do not let each feature draw its own private frame. Crop, path edit, marquee,
layer bounds, transform handles, magnetic-lasso work paths, and mask overlays
must share ordering rules.

Required overlay classes:

| Overlay | Owner | Notes |
| --- | --- | --- |
| Target bounds | active target resolver | Quiet outline for selected layer/mask/object. |
| Transform frame | transform/move tool state | Handles only when direct transform is active. |
| Selection ants | active selection state | Already separate from layer/mask; render only after a draft has been committed. |
| Work path / selection draft | path/lasso/pen/marquee draft state | Solid outline before "make selection"; ants only after selection exists. |
| Crop frame | crop tool state | Blue crop frame and size panel remain crop-owned. |
| Mask tint | mask preview/quick-mask state | Must not obscure target bounds. |

The renderer can still be DOM canvas now and WGPU later. The important rule is
that the scene model is independent of the rendering backend.

### Context Action Bar

The floating bar near the active object should be a command view, not a feature
owner.

For a closed selection draft, the compact Make Selection / Cancel / Edit
Anchors surface is the draft affordance defined in
[`IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md).
It is not a Studio Action target and must not become a second selection
implementation. It renders commands from the draft command model, then
disappears when Make Selection commits the draft into an addressable
`ActiveSelection`.

It should receive:

```ts
interface ContextActionBarModel {
  anchor: Rect | Point;
  target: StudioTarget;
  primaryActions: CommandId[];
  overflowActions: CommandId[];
}
```

It should not decide whether "remove background" is valid. It only renders
commands that the capability resolver already approved.

Examples:

| Active target | Primary actions |
| --- | --- |
| Pixel layer | Select subject, remove background, add mask, duplicate, transform. |
| Layer mask | Invert mask, refine edge, disable/enable mask, delete mask. |
| Selection | Add to mask, fill, delete, invert selection, feather. |
| Path | Make selection, convert to mask, edit anchors, delete path. |
| Node output preview | Open editor, quick mask, quick crop, accept/apply. |

The action bar should use icons. Text belongs in tooltips and command search,
not in the compact canvas overlay.

### Command Registry And Capabilities

Commands must be centralized.

Suggested shape:

```ts
interface StudioCommand {
  id: CommandId;
  titleKey: string;
  icon: IconId;
  group: "selection" | "layer" | "mask" | "path" | "transform" | "ai" | "file";
  run: (ctx: CommandContext) => void | Promise<void>;
}

interface CommandCapability {
  enabled: boolean;
  reason?: string;
  danger?: boolean;
  requiresPreview?: boolean;
}
```

Every command surface should use the same registry:

- context action bar;
- right-click menu;
- right rail buttons;
- top menu;
- keyboard shortcuts;
- Studio Action / assistant action runtime.

Do not duplicate "can this command run?" logic in React components.

Capability resolver inputs:

```text
active target
document state
layer lock/visibility/mask state
selection/path state
active tool
workspace kind
backend availability
```

Capability examples:

| Command | Enabled when |
| --- | --- |
| Add mask | active target is editable pixel layer and no mask exists. |
| Delete mask | active target is layer mask and layer is not locked. |
| Remove background | target can resolve to image pixels and model/compute backend is available. |
| Refine edge | target is selection or selection-alpha artifact. |
| Transform | target has transformable bounds and is not locked. |
| Delete | target is not document, not locked, and deletion is target-safe. |

### Right Rail Relationship

The right rail should not permanently consume space with generic settings.

Recommended separation:

| Surface | Role |
| --- | --- |
| Canvas overlay | Shows active target and direct manipulation affordances. |
| Context action bar | Short, high-frequency commands for the active target. |
| Right rail | Detailed properties, numeric fields, advanced settings, history/layers. |
| Context menu | Full target-specific command list. |

Selecting a layer can reveal a target outline and action bar, but detailed
properties should stay in the right rail panel. The action bar is for short
actions only.

### Studio Action Integration

Studio Action should call commands through the same registry. It should not
click UI.

Correct path:

```text
assistant/user intent
  -> resolve StudioTarget
  -> choose StudioCommand
  -> capability check
  -> dry run / preview artifact
  -> commit transaction
  -> history entry
```

This is how quick operations can remain safe:

- "remove the background from this layer" resolves to the selected pixel layer;
- "invert this mask" resolves to the active layer-mask target;
- "turn this selection into a mask" resolves selection + layer target;
- "use SAM 2 on this object" resolves image target + prompt hints.

If the target is ambiguous, the action must ask for clarification or show a
target picker. It must not guess by reading whichever panel was last clicked.

### Implementation Phases

Phase 1: Target and bounds foundation.

- Normalize `StudioTarget` so pixel layer, layer mask, selection, path, and
  node output are distinct.
- Add a pure target-bounds resolver.
- Add tests for layer frame vs content bounds vs selection/path bounds.

Phase 2: Overlay scene.

- Build a shared overlay scene model.
- Move active-layer target outline into the overlay scene.
- Keep crop, selection ants, path edit, and mask tint ordered by scene rules.

Phase 3: Command registry.

- Define command ids, icons, titles, groups, and run handlers.
- Move layer action buttons, context menus, and shortcuts onto the registry.
- Add capability resolver tests.

Phase 4: Context action bar.

- Render high-frequency actions near the active target bounds.
- Keep text out of the compact bar; use icons + tooltip/aria labels.
- Add overflow menu for less common actions.

Phase 5: Studio Action bridge.

- Let assistant/agent actions call the command registry by target id.
- Require preview/dry-run for destructive or model-backed commands.
- Commit through normal history, not hidden mutable UI state.

### Non-Negotiable Rules

- Do not implement layer target outlines as a one-off DOM element.
- Do not let the layer panel own canvas overlays.
- Do not let floating toolbars decide command availability.
- Do not let the selection-draft affordance read pixels, mutate layers, or
  become a Studio Action target before Make Selection commits it.
- Do not duplicate command logic between right rail, context menu, shortcuts,
  and future Studio Action.
- Do not collapse pixel layer, layer mask, selection, and path into one
  generic "current edit" state.
- Do not make expensive AI/model commands run merely because a target is
  selected; run them only when the command is invoked.

## SAM 2 As A Compute Block

SAM 2 is one of the best early compute blocks for Studio Action because it is
not a vague AI feature. It has a clear contract:

```text
image + prompts -> mask
```

It should be exposed as a structured compute action, not as a hidden UI click.

### Inputs

```ts
interface Sam2SelectionAlphaRequest {
  imageRef: string;
  targetSpace: "document" | "layer" | "viewport";
  points?: Array<{ x: number; y: number; label: 0 | 1 }>;
  box?: [number, number, number, number];
  pathId?: string;
  selectionId?: string;
  variant?: "tiny" | "small" | "base_plus" | "large";
  backendRef?: string;
}
```

### Outputs

```ts
interface Sam2SelectionAlphaResult {
  selectionAlphaArtifactRef: string;
  confidence?: number;
  bbox?: [number, number, number, number];
  provider: "sam2" | "builtin-cpu" | string;
  variantUsed?: string;
}
```

### Correct Placement

SAM 2 can be used by:

- the Subject Mask / Mask-Matte row;
- the image editor's layer-mask target;
- a preview/review gate;
- a Studio Action requested by the assistant.

It should not become:

- a random standalone low-level node for every small use;
- a UI automation step;
- an action that silently creates new layers;
- a replacement for user-controlled pen/path/selection work.

## User-Precise Selection + Model Assist

The strongest path is not "throw image into model and hope."

The stronger path is:

```text
user precise target
  -> pen path / lasso / points / rough box / selected layer
  -> SAM 2 or mask compute
  -> preview
  -> manual correction if needed
  -> commit to layer mask / selection / graph output
```

The user's precise edit is the anchor. SAM 2 fills the expensive computation
role, especially when the user gives it positive/negative points or a path/box
hint.

Examples:

| User action | Compute action | Result |
| --- | --- | --- |
| Pen roughly around object | SAM 2 constrained by path/box | Clean object mask preview. |
| Click positive and negative points | SAM 2 point-prompt mask | Interactive subject selection. |
| Existing selection too rough | SAM 2 refine from selection bbox/points | Better selection-alpha artifact. |
| Hair/glass edge uncertain | ViTMatte/guided matte after trimap | Continuous alpha edge. |

## Studio Action Chain

Studio Action should be an internal action runtime. It can later be driven by
Goose, another agent library, or H-Gripe's own assistant, but the product
contract should be independent of the agent framework.

```text
Assistant / API / local model
  -> intent parse
  -> StudioActionRegistry
  -> target resolver
  -> capability/backend resolver
  -> dry run report
  -> preview gate
  -> commit transaction
  -> undoable edit history
```

### Action Schema Shape

```ts
interface StudioAction<TParams = unknown> {
  id: string;
  label: string;
  capabilities: string[];
  requiredTarget: StudioTarget["kind"][];
  params: TParams;
  dryRun(ctx: ActionContext): ActionPlan;
  preview(ctx: ActionContext): PreviewArtifact;
  commit(ctx: ActionContext): CommitResult;
}
```

### Example Actions

```text
create_layer_mask(layer_target)
set_active_target(layer_mask)
run_sam2_prompt_mask(layer_mask, points, variant)
commit_selection_alpha_artifact_to_layer_mask(layer_mask, selectionAlphaArtifactRef)
feather_layer_mask(layer_mask, radiusPx)
generate_selection_from_path(pathId)
commit_selection_to_layer_mask(selectionId, layerMaskTarget)
open_selection_alpha_preview(selectionAlphaArtifactRef)
undo_last_action()
```

Every action should answer:

- what target it will touch;
- which backend/model it will call, if any;
- whether it costs local GPU/CPU/API money;
- what artifact it will create;
- how it can be previewed;
- how it is undone.

## Agent Boundary

Goose or any other agent runtime should not be allowed to click around the UI
or mutate editor state directly.

Allowed:

```text
agent -> calls approved StudioAction
```

Not allowed:

```text
agent -> clicks toolbar
agent -> drags canvas
agent -> guesses active layer
agent -> writes raw edit_paths JSON
```

The agent can propose:

```text
"Use SAM 2 on the active layer mask with these points, then feather 2px."
```

The Studio Action runtime resolves and previews:

```text
target: layer_mask(layer-7/mask-1)
actions:
  1. run_sam2_prompt_mask
  2. feather_layer_mask
  3. preview
commit: waiting for user confirmation
```

This keeps AI helpful without giving it unsafe control over the editor.

## Required Preconditions

### 1. Layer/Mask Target Contract

Add a document-level contract for:

- pixel layer id;
- optional layer mask id;
- active target kind;
- mask link state;
- mask enabled/disabled state;
- mask thumbnail/artifact ref;
- mask edit stack.

### 2. PS-Aligned Layers Panel

The layer panel should show image thumbnail and mask thumbnail in the same row,
with reserved slots. Mask creation should attach to the row, not create a new
ordinary layer by default.

### 3. Selection Target Protocol

Selections need persistent ids and source metadata. This applies only to
committed active selections, not to solid tool drafts. The draft-to-active
rules live in
[`IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md).

```ts
interface SelectionTarget {
  id: string;
  source: "pen" | "lasso" | "marquee" | "sam2" | "wand" | "mask";
  bounds: [number, number, number, number];
  selectionAlphaArtifactRef?: string;
  pathId?: string;
}
```

The selection may be temporary, but while it exists it should be addressable by
actions and previews.

Non-negotiable rules:

- `SelectionDraft` has no `selectionId`.
- Studio Action cannot target an uncommitted draft.
- `Ctrl+J`, selection-to-mask, feather, invert, and delete consume the
  committed active selection state, not the tool that drew it.
- If the user wants to use a path/draft as an action input, the command chain
  is `path/draft -> Make Selection -> ActiveSelection(selectionId) -> action`.

### 4. Compute Block Registry

SAM 2, BiRefNet, ViTMatte, guided-filter matte, colour-feature preprocess, and
future inpaint/repair models should register as compute blocks with capability
ids.

Examples:

```text
mask.subject.point_prompt
mask.subject.salient
matte.alpha.refine
selection.from_colour
selection.from_path
image.inpaint
```

The registry should reuse the completed model/API manager contracts for
backend selection and health checks.

### 5. Preview / Commit / Undo Transaction

No Studio Action should immediately destructively mutate the document. The
minimum transaction stages are:

```text
dry_run -> preview -> commit -> undo record
```

For cheap deterministic actions, preview can be immediate. For expensive
SAM/API actions, the preview gate should show target, backend, cost class, and
result artifact before commit.

## Implementation Order

1. Freeze the layer/mask target data contract.
2. Update the layer panel to PS-style row semantics: content thumbnail + link +
   mask thumbnail + stable active target.
3. Separate "add layer mask" from "new layer."
4. Add selection/path/mask target ids and target resolver utilities.
5. Define compute block capability registry, starting with SAM 2 as
   `mask.subject.point_prompt`.
6. Define `StudioActionRegistry` with dry-run/preview/commit/undo stages.
7. Add first non-agent actions:
   - create layer mask;
   - selection to layer mask;
   - SAM 2 prompt mask to layer mask;
   - feather mask.
8. Only after the action contract is stable, connect assistant/Goose-style
   agent runtime as a caller of approved actions.

## Non-Goals

- Do not let the agent directly operate UI widgets.
- Do not make SAM 2 a magical layer creator.
- Do not represent every mask as a sibling layer.
- Do not expose every compute helper as a separate visible palette node.
- Do not make API/local model settings live inside mask actions.
- Do not make destructive "apply mask" the default path.

## Success Criteria

The design is ready for implementation when:

1. A layer row can own a mask thumbnail and the user can clearly activate either
   pixel or mask target.
2. Creating a mask no longer looks like creating a new ordinary layer.
3. A pen path, SAM 2 point prompt, or selection can be referenced by id.
4. SAM 2 can run as a compute block and return a previewable selection-alpha artifact.
5. Studio Action can say exactly what it will touch before it commits.
6. The assistant can call only approved actions, never raw UI operations.

When these are true, Goose or another agent layer becomes an adapter, not a
foundation risk.
