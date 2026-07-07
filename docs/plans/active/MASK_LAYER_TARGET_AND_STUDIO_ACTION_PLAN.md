# Mask Layer Target And Studio Action Plan

> Status: active planning document.
> Purpose: define the required mask/layer target model before building
> Studio Action or any AI-agent-driven quick operation path.

## Hard Gate

Do not build the Studio Action agent chain until the mask editor's layer/mask
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
the result returns as a traceable image/layer/mask artifact, not as an invisible
mutation of the canvas node.

Non-negotiable rules:

- do not put the full image editor inside a node card;
- do not make preview into a second image editor with duplicated state;
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

- a pen path can create a selection;
- a selection can become a layer mask;
- SAM 2 can produce a mask artifact from points/box/path hints;
- a mask artifact can be attached to a layer mask target;
- a node output can open in the image editor, then be edited into a document.

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
| Selection active | Tools modify the floating selection, not yet a layer mask. |
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

## SAM 2 As A Compute Block

SAM 2 is one of the best early compute blocks for Studio Action because it is
not a vague AI feature. It has a clear contract:

```text
image + prompts -> mask
```

It should be exposed as a structured compute action, not as a hidden UI click.

### Inputs

```ts
interface Sam2MaskRequest {
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
interface Sam2MaskResult {
  maskArtifactRef: string;
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
| Existing selection too rough | SAM 2 refine from selection bbox/points | Better mask artifact. |
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
commit_mask_artifact_to_layer_mask(layer_mask, maskArtifactRef)
feather_layer_mask(layer_mask, radiusPx)
generate_selection_from_path(pathId)
commit_selection_to_layer_mask(selectionId, layerMaskTarget)
open_mask_preview(maskArtifactRef)
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

Selections need persistent ids and source metadata:

```ts
interface SelectionTarget {
  id: string;
  source: "pen" | "lasso" | "marquee" | "sam2" | "wand" | "mask";
  bounds: [number, number, number, number];
  maskArtifactRef?: string;
  pathId?: string;
}
```

The selection may be temporary, but while it exists it should be addressable by
actions and previews.

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
4. SAM 2 can run as a compute block and return a previewable mask artifact.
5. Studio Action can say exactly what it will touch before it commits.
6. The assistant can call only approved actions, never raw UI operations.

When these are true, Goose or another agent layer becomes an adapter, not a
foundation risk.
