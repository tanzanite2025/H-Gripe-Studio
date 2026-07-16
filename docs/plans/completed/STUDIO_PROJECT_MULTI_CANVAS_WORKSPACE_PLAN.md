# Studio Project Multi-Canvas Workspace Plan

> Historical note (2026-07-16): this completed plan is retained only as an
> implementation record. Treat the remaining text as history, not current
> product guidance.

> Status: completed. All five migration phases landed (PRs #382–#386), plus
> the "Open Workflow imports into a new tab" behavior (PR #387).
> Purpose: define the long-term project, multi-canvas tab, and toolbar
> information architecture so the studio does not keep patching the current
> single-canvas shell.

## Core Problem

The current workspace still mixes several different product layers into one
visible toolbar:

- project commands: new, open, save
- canvas commands: undo, redo, search, fit, zoom
- canvas display options: connection style, minimap, snapping
- global settings: language, theme, app-level configuration
- runtime commands: run, cancel, logs, history

This makes the UI look busy, but the deeper risk is behavioral: if a user is
already working on a canvas, a vague `New` command can be interpreted as
clearing the current graph. That is not acceptable for a production tool.

H-Gripe Studio should treat a project as the container, and each node canvas as
one document inside that project. A real project can contain multiple workflow
canvases, timeline experiments, prompt branches, PSD/layer pipelines, and export
routes.

## Core Product Model

### StudioProject

`StudioProject` is the top-level container. It owns:

- project id
- project name
- project path or storage ref
- asset registry
- media cache refs
- workflow/canvas document list
- project-level settings
- API/model profile refs, not credentials themselves

The project is not the graph. The graph is only one document inside the
project.

### CanvasDocument

Each visible canvas tab maps to a `CanvasDocument` or `WorkflowDocument`.

Minimum state:

```ts
type CanvasDocument = {
  id: string;
  title: string;
  path?: string;
  kind: "workflow";
  nodes: unknown[];
  edges: unknown[];
  dirty: boolean;
  selectedNodeId?: string;
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
  historyScopeId: string;
  runState: "idle" | "running" | "failed" | "complete";
};
```

The exact node and edge types can keep using the current graph model at first.
The important change is wrapping the existing graph state in a document shell so
the app can hold more than one canvas safely.

## UX Hierarchy

### 1. App / Global Row

This is the software-level row. It should stay stable even when the active
canvas changes.

Recommended contents:

- app title / brand
- current project name
- global command/search input in the center
- global status: save state, engine status, model/API status
- language switch
- theme / settings
- account/license area if ever needed

`EN` or any global language switch belongs here, preferably on the right side.
It should not sit before undo/redo because language is not a canvas editing
operation.

If the native Windows title bar remains enabled, the custom close/minimize/max
buttons should not be duplicated in this row. If the app later switches to a
frameless window, this row can own the window controls, but that should be a
single deliberate shell decision.

### 2. Canvas Tab Row

This row represents open documents inside the current project.

Recommended contents:

- canvas tabs
- dirty indicator per tab
- close button per tab
- `New Canvas` button
- optional tab overflow menu

This is where the user understands that multiple canvases can be open at the
same time. It also prevents `New` from feeling like it will erase the current
work.

### 3. Canvas Context Toolbar

This row only controls the active canvas view and graph editing context.

Recommended groups:

- undo / redo
- active canvas search
- selection tools
- zoom / fit
- connection style
- minimap toggle
- snapping toggle
- tidy / layout actions

The canvas toolbar should not repeat app identity text that already exists in
the main window header. Labels such as `H-Gripe Studio` or `API 优先控制台`
should not sit before the canvas search input. They consume horizontal room,
push the search and canvas controls away from the center, and create the feeling
that the app shell is nested inside itself. The toolbar can show the active
canvas title or tab state through the canvas tab row, but brand and global
subtitle text belong only to the app/global row.

Connection style, minimap, and snapping should live near canvas search and view
tools because they are canvas display/editing options. They should not be mixed
with project file commands or global language controls.

### 4. Run / Execution Group

Run commands are scoped to the active canvas document unless the user explicitly
runs a project-level batch.

Recommended contents:

- run active canvas
- cancel active run
- run logs
- snapshots / history for active canvas
- export handoff if the active graph produces deliverables

The UI should make it clear whether a command affects one canvas, all canvases
in a project, or a selected node/subgraph.

### 5. Project Commands

Project and file commands should be explicit:

- New Project
- Open Project
- Save Project
- Save Project As
- New Canvas
- Import Workflow Into New Tab
- Export Active Canvas

Avoid one ambiguous `New` command. At minimum, labels should distinguish
`New Project` from `New Canvas`.

## New / Open / Save Behavior

| Command | Expected Behavior |
| --- | --- |
| New Project | Creates a new empty project container. If the current project has dirty canvases, prompt before switching. |
| New Canvas | Adds a new canvas tab inside the current project. It must not clear the current active canvas. |
| Open Project | Opens or switches to a project container. Dirty current project prompts first. |
| Open Workflow | Imports or opens a workflow as a new canvas tab inside the current project. |
| Save | Saves the active canvas document when focus is in the canvas. |
| Save Project | Saves the project manifest plus all dirty project-level metadata. |
| Close Tab | Closes one canvas tab. Dirty tab prompts before closing. |

The UI can later support keyboard shortcuts, but the behavior must be scoped
first. Shortcut polish should not hide ambiguous data-loss semantics.

## Autosave, History, And Snapshots

Autosave keys must include both project and canvas identity:

```text
autosave:{projectId}:{canvasDocumentId}
```

History and snapshots should also be scoped:

```text
historyScopeId = canvasDocumentId
runSnapshotId = projectId + canvasDocumentId + runId
```

This prevents one canvas from overwriting another canvas's undo stack, runtime
snapshot, or autosave recovery state.

## Inspector And Side Panels

The right inspector should not permanently consume canvas width. It should open
on demand from a node title action, a selected-node command, or a settings
button.

Long-term rule:

- empty selection: no heavy inspector mount
- node selected: lightweight node summary can appear if needed
- settings clicked: inspector drawer opens for that node
- run/model probing: only happens from explicit run, refresh, or model manager
  actions

Canvas space is the product surface. Permanent panels should justify their
presence by showing active work, not by waiting for possible future selection.

## Relationship To Existing Plans

This plan does not replace the unified production drawer. The drawer still owns
Edit / Timeline and Grade. This plan defines the shell above the canvas and how
multiple graph documents live inside a project.

This plan also does not replace the node-card boundary plan. Node-card design
continues to decide what belongs inside a product card. This plan decides where
project, document, canvas, and global commands belong.

## Migration Path

### Phase 1: Naming And Toolbar Semantics (done, PR #382)

- Rename ambiguous `New` surfaces into `New Project` or `New Canvas`.
- Move global language control to the app/global row.
- Remove repeated brand/subtitle text from the canvas toolbar when the main
  window header already shows it.
- Group connection style, minimap, snapping, search, and zoom as canvas tools.
- Keep current single-canvas state internally.

### Phase 2: CanvasDocument Wrapper (done, PR #383)

- Wrap the current graph state in one `CanvasDocument`.
- Move selected node, viewport, dirty state, and history scope into that wrapper.
- Keep persistence compatible with the current workflow format.

### Phase 3: In-Memory Multi-Canvas Tabs (done, PR #384)

- Add a tab bar for multiple open `CanvasDocument` objects.
- Make undo/redo, search, inspector, run state, and snapshots use the active
  canvas id.
- Ensure `New Canvas` never mutates or clears another tab.

### Phase 4: Project Manifest Persistence (done, PR #385)

- Add a project manifest that lists canvas documents and asset refs.
- Save and restore multiple canvas tabs.
- Track dirty state at both project and canvas levels.

### Phase 5: Project-Level Commands And Batch (done, PR #386)

- Add explicit project-level run/export only after document scoping is stable.
- Make batch commands visibly different from active-canvas commands.
- Keep project-level actions out of the normal canvas editing toolbar unless
  the user enters a project/batch mode.

### Delivered Shape

- Canvas tab row with per-tab dirty markers, close buttons, and `New Canvas`
  (`CanvasTabs`, `useCanvasDocument`); undo/snapshot/inspector scope follows
  the active document id.
- Open tab set persists through a project manifest (`project.manifest.json`
  next to the workspace autosave on desktop, localStorage in the browser
  preview); the legacy single autosave keeps working underneath.
- `Open Workflow` imports into a new tab; opening an already-open path
  activates its tab instead of duplicating it (PR #387).
- Project-level batch: a "Run all canvases" action on the tab row (shown with
  2+ tabs, outside the canvas toolbar) runs every open canvas sequentially
  under one `"project"` run-history record; only the active canvas paints
  statuses/previews, parked canvases report through the run log.

## Non-Goals

- Do not build a full IDE-style file explorer as the first step.
- Do not move Edit / Timeline / Grade out of the bottom production drawer.
- Do not make the node canvas own heavy image/video pixel buffers.
- Do not solve every persistence format in the first PR.
- Do not add another always-open side panel to compensate for missing tab/state
  architecture.

## Success Criteria

The user should be able to say:

```text
I am in Project A.
I have Canvas 1, Canvas 2, and Canvas 3 open.
New Canvas creates Canvas 4 without touching the others.
Undo, redo, search, minimap, snapping, run, and inspector all apply to the
active canvas unless clearly marked otherwise.
Language, theme, API/model management, and app settings are global and do not
sit inside the canvas editing flow.
```

When this is true, the studio shell can grow into a serious multi-document
production workspace instead of a single graph view with more buttons attached
to it.
