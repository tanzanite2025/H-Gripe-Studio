# Page Context Agent Preset Plan

> Status: active planning document.
> Purpose: define how H-Gripe Studio should route the assistant/agent system by
> page context without creating multiple uncontrolled agents or duplicating
> commands already owned by each workspace.

## Core Decision

Use one assistant shell and one agent runtime.

Do not create separate user-facing agents that compete for state. Instead, load
a page-specific preset according to the active workspace:

```text
Assistant shell
  -> PageContext
  -> AgentPreset
  -> allowed reads
  -> allowed Studio Actions
  -> dry-run / preview / commit
```

The user should feel like there is one assistant that understands the current
workspace, not five different bots.

## Why Page Presets Matter

Different pages need different safety boundaries.

An image-editing assistant should understand layers, masks, paths, selections,
SAM 2, matting, repair, and adjustment targets. It should not be allowed to
delete projects, edit API credentials, run full-canvas exports, or mutate the
timeline.

A model/API assistant should understand provider profiles, local model health,
weights paths, capability checks, and device reports. It should not touch image
layers or graph wiring.

The preset is therefore not just a prompt. It is a capability boundary.

## Relationship To Existing Plans

This plan depends on these contracts:

- [`MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md`](MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md)
  for target-safe mask/layer actions.
- [`../completed/PROMPT_ASSISTANT_SYSTEM_PLAN.md`](../completed/PROMPT_ASSISTANT_SYSTEM_PLAN.md)
  for the assistant shell and session boundary.
- [`../completed/API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](../completed/API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md)
  for backend refs and capability-filtered model/API selection.
- [`../completed/RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN.md`](../completed/RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN.md)
  for run scope vocabulary.
- [`../completed/UNIFIED_PRODUCTION_DRAWER_PLAN.md`](../completed/UNIFIED_PRODUCTION_DRAWER_PLAN.md)
  for the editor/timeline/grade workspace boundary.

Do not implement free-form agent tool access before the Studio Action contract
exists. The assistant may talk before then, but it must not perform destructive
or editor-mutating actions directly.

## Preset Model

```ts
interface PageContext {
  workspace:
    | "project"
    | "canvas"
    | "image_editor"
    | "timeline_grade"
    | "model_api"
    | "settings";
  activeCanvasId?: string;
  activeDocumentId?: string;
  selectedNodeIds?: string[];
  selectedTargets?: StudioTarget[];
  activeRunScope?: RunScope;
  openPanelId?: string;
}

interface AgentPreset {
  id: string;
  label: string;
  systemPolicy: string;
  allowedReadModels: string[];
  allowedActionIds: string[];
  forbiddenActionIds?: string[];
  defaultBackendCapability: string;
  costPolicy: "local_only" | "confirm_api" | "confirm_expensive";
}
```

The preset controls:

- what context the assistant may read;
- what actions it may call;
- which backend capability it prefers;
- whether API/local-heavy work needs confirmation;
- how results are previewed and committed.

## Recommended Presets

### Global / Project Preset

Purpose: project structure, files, project settings, recent canvases, asset
overview, and general planning.

Allowed reads:

```text
project manifest
canvas list
asset registry
recent run reports
high-level settings status
```

Allowed actions:

```text
open_project_panel
create_canvas
rename_canvas
open_asset_panel
show_project_settings
```

Not allowed:

```text
edit_image_pixels
mutate_layer_mask
change_api_secret
run_expensive_model
export_final_media
```

### Canvas Preset

Purpose: node graph understanding, wiring diagnosis, run scope, cached results,
and graph-level troubleshooting.

Allowed reads:

```text
selected nodes
node specs
edges
run reports
backend validation reports
output cache summaries
```

Allowed actions:

```text
explain_selected_nodes
validate_backend_refs
run_selected_with_upstream
run_to_node
run_downstream
open_node_result_preview
```

`open_node_result_preview` opens the shared software-level preview modal. It
does not give the agent a private image editor inside the canvas. If an edit is
requested from that preview, the action must resolve the same node output,
asset, layer, or mask target and then call a whitelisted Studio Action.

Not allowed:

```text
edit API credentials
directly edit image layer pixels
rewrite arbitrary graph JSON
run full canvas without confirmation
```

### Image Editor Preset

Purpose: layers, masks, selections, paths, SAM 2, matting, repair, adjustment
targets, and previewable image operations.

Allowed reads:

```text
active document
layer stack
active layer target
layer mask targets
selection targets
path targets
history stack
current viewport/read-only pixels
```

Allowed actions:

```text
set_active_target
create_layer_mask
run_sam2_prompt_mask_preview
commit_mask_artifact_to_layer_mask
generate_selection_from_path
commit_selection_to_layer_mask
feather_layer_mask_preview
undo_editor_action
open_operation_preview
```

`open_operation_preview` is only a preview/review gate over the shared
Studio Action / compute-block layer. Quick mask, crop, grade, or matte previews
may be proposed there, but commit still goes through target resolution and the
normal preview/commit/undo transaction. Full layer or path correction belongs
to the image editor preset on the same target.

Not allowed:

```text
new_project
change_model_api_secret
run_full_canvas
edit_timeline_tracks
destructive_apply_mask_without_confirmation
```

This preset must not duplicate image-editor toolbar commands in the app chrome.
If a command belongs to the image editor, the assistant should invoke the
image-editor action internally or tell the user where it is. The top app bar
should not grow a second copy of image-editor commands.

### Timeline / Grade Preset

Purpose: clip selection, timeline run scopes, color grade targets, keyframes,
audio clips, render previews, and export preparation.

Allowed reads:

```text
active timeline
selected clips
track state
grade stack
render preview status
audio/video device reports
```

Allowed actions:

```text
open_clip_editor
open_grade_panel
apply_grade_preview
add_keyframe_preview
run_timeline_preview
prepare_export_report
undo_timeline_action
```

Not allowed:

```text
change API credentials
mutate image-editor layer masks
delete project
export_final_media_without_confirmation
```

Timeline-specific commands such as cut, ripple, trim, keyframe edit, snap, and
track lock belong inside the timeline workspace. The assistant may explain or
invoke safe actions, but the global toolbar should not list those commands.

### Model / API Preset

Purpose: API profiles, local model refs, health checks, capability mismatch,
weights paths, device/precision policy, and fallback reports.

Allowed reads:

```text
API profile registry without secrets
local model registry
capability map
backend health status
device reports
recent backend validation errors
```

Allowed actions:

```text
open_model_api_manager
test_api_profile
probe_local_model
show_missing_capability_report
show_device_report
```

Not allowed:

```text
read raw API keys
write raw secrets into graph JSON
edit image layers
run arbitrary project actions
delete model files without explicit confirmation
```

The assistant should never expose raw credentials in messages. It can show
labels, capability status, and remediation steps.

### Settings Preset

Purpose: global preference explanation and navigation to settings panels.

Allowed actions should be minimal:

```text
open_settings
open_shortcuts
open_language_settings
open_about
open_diagnostics
```

Avoid creating one command per settings option in the top toolbar. If a setting
has a proper settings panel, the assistant should route there.

## UI Placement

Use one Assistant entry that stays reachable across pages.

Recommended behavior:

```text
Assistant panel header:
  mode: Auto (Image Editor) / Canvas / Timeline / Model API / Project
  target summary: Layer Mask: layer-7 / Selected Nodes: 3 / Clip: A003
```

The mode should auto-follow the active workspace, but the user may pin a mode
temporarily when they need to ask cross-context questions.

The panel should not live inside the bottom drawer. It must remain reachable
when timeline/grade is open.

## Command Placement Rule

Keep paths short.

```text
If a command belongs to the current object, put it beside that object.
If a command belongs to a page panel, keep it in that panel.
If a command is global or cross-page, expose one system entry.
```

Therefore:

- image editor commands stay inside the image editor;
- timeline commands stay inside the timeline/grade workspace;
- node run-to/downstream commands stay on node/card context menus;
- model selection stays on cards/rows/assistant where the target is known;
- API/model management gets one system entry.

The assistant can help discover and call actions, but it should not cause the
top app chrome to become a giant command menu.

## Studio Action Permission Boundary

Every page preset should expose a whitelist:

```ts
type AgentPermission =
  | { kind: "read"; scope: string }
  | { kind: "action"; actionId: string }
  | { kind: "backend"; capability: string }
  | { kind: "cost"; policy: "free" | "local_heavy" | "api_billable" };
```

Before an action runs:

```text
1. resolve page context
2. resolve target
3. check preset whitelist
4. dry run
5. show preview/report if needed
6. commit only after explicit confirmation when destructive/expensive
```

No preset should allow direct UI automation as its primary path.

## Agent Runtime / Goose Relationship

Goose or another agent framework may be useful later as a runtime adapter, but
it should not define the product boundary.

The stable H-Gripe contract is:

```text
PageContext + AgentPreset + StudioActionRegistry
```

Any external agent runtime must adapt to that contract:

```text
Goose tool bundle
  -> exposes approved Studio Actions
  -> receives sanitized PageContext
  -> cannot call raw UI events
```

This keeps the framework replaceable. If Goose is useful, it can reduce agent
runtime work. If it is too heavy or too general, the same presets still work
with a lighter H-Gripe runtime.

## Session And Memory

Assistant sessions remain separate from workflow graph persistence.

Recommended state split:

```text
assistant session:
  messages
  selected backend ref
  pinned preset mode
  drafts / proposed actions

project/workflow:
  confirmed prompt text
  committed Studio Actions
  graph nodes/edges
  editor documents
```

The assistant may reference project state, but an informal conversation should
not become part of deterministic graph execution.

## Implementation Order

1. Define `PageContext` and context providers for project, canvas, image
   editor, timeline/grade, model/API, and settings.
2. Define `AgentPreset` data and a static registry of page presets.
3. Add Assistant header mode display: auto mode plus optional pinned mode.
4. Add read-only context summaries per preset.
5. Add action whitelist enforcement before any write action.
6. Wire the Image Editor preset only after the layer/mask target model from
   `MASK_LAYER_TARGET_AND_STUDIO_ACTION_PLAN.md` is stable.
7. Wire Canvas preset to existing run scope actions.
8. Wire Model/API preset to manager health checks and capability reports.
9. Only then evaluate Goose as an adapter for action calling.

## Non-Goals

- Do not create multiple independent assistants that keep separate hidden
  state.
- Do not let agents click UI controls as the normal execution path.
- Do not duplicate editor/timeline commands in the global toolbar.
- Do not expose raw API keys or secrets to assistant messages.
- Do not let a page preset call actions outside its workspace without an
  explicit cross-context confirmation.
- Do not make every panel command a top-level system command.

## Success Criteria

This plan is ready when:

1. The assistant can tell which page/workspace is active.
2. Each preset has a small, explicit read/action whitelist.
3. Image Editor actions can only touch resolved layer/mask/selection/path
   targets.
4. Canvas actions reuse `RunScope`, not ad-hoc graph mutation.
5. Model/API actions can diagnose configuration without exposing secrets.
6. Goose or any other agent framework remains an adapter, not the core product
   dependency.
