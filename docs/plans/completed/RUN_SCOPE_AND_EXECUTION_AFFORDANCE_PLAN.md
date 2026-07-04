# Run Scope And Execution Affordance Plan

> Status: complete. Landed via PRs #402 (RunScope type + scope resolver, steps
> 1–2), #403 (row-level run for integrated cards, step 3), #404 (card /
> selection / downstream run affordances + row-scoped ref validation, steps
> 4–7), and #405 (pre-execution run reports, step 8). Execution zones and
> execution nodes stay future reference ideas (step 9).
> Purpose: define how users run parts of a canvas without introducing confusing
> execution zones or execution nodes too early.

## Core Decision

Execution controls should attach to production objects first:

```text
row run
card run
run to node
run selection
run downstream
run full canvas
```

Do not start with a separate execution zone or an execution node. Those ideas may
be useful later, but they are too easy to confuse with graph structure before
run scope is well-defined.

Lines describe data flow. A run command describes execution scope. Do not make
the user infer run scope only from wiring.

## Current Baseline After Model Manager Work

The model/backend foundation is already in place:

- global Models / APIs manager and registry exist
- card API profile selectors exist
- local model selectors exist
- `Image Processing` rows can store capability-filtered backend refs
- pre-run backend ref validation exists
- `runUpToNode` already runs a node and its transitive inputs

Therefore this plan should not rebuild model/backend selection. Row/card scoped
runs should reuse the completed backend selection contract in
[`NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md`](NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md)
and the existing backend validation path.

The remaining execution work is scope and affordance:

```text
which row/card/selection is being run
which upstream dependencies are included
whether downstream propagation is explicit
how results, skipped rows, backend refs, and device reports are shown
```

## Why Not Execution Zones First

An execution zone is a visible region on the canvas where the user drags cards
into a framed area and runs that region.

Potential value later:

- stage grouping
- experiment grouping
- batch lanes
- project phase organization

But first-version risks are high:

- the user must drag cards into the zone, which disturbs layout and wiring
- a card can be visually inside the zone while connected to cards outside it
- running "inside only" can conflict with upstream dependencies outside the zone
- running "inside only" but ignoring connected downstream cards feels arbitrary
- zones can become another graph abstraction before the graph itself is stable

Execution zones should stay a later reference idea, not the first execution
affordance.

## Why Not Execution Nodes First

An execution node turns run control into graph data.

The ambiguity appears immediately:

```text
Execute node connected to input:
  run upstream?

Execute node connected to output:
  run downstream?

Execute node connected between cards:
  block, trigger, or scope boundary?
```

This makes the graph read like implementation plumbing. It also risks pushing
H-Gripe Studio toward a low-level workflow-builder feel, where users debug
run-control blocks instead of operating production cards.

Execution nodes may be useful later for automation:

- scheduled trigger
- webhook trigger
- batch trigger
- export trigger
- watch-folder trigger

They should not be the normal way to run a row, a card, or a selected chain.

## Preferred First Execution Model

### Row Run

For multi-operation cards such as `Image Processing`, each row can expose a
small run affordance:

```text
Enhance          [Run]
Grade            [Run]
Crop / Transform [Run]
Mask / Matte     [Run]
Repair / Repaint [Run]
```

`Run row` means:

- compute only that row's required upstream dependencies
- execute that row
- update that row's output/result cache
- do not execute sibling rows
- do not automatically run downstream consumers unless the user explicitly
  chooses a downstream command

This pairs with the completed
[`NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md`](NODE_CARD_BACKEND_SELECTION_CONTRACT_PLAN.md):
row run executes the row with its selected built-in/API/local backend and row
params, after the same backend ref validation used by full-canvas runs.

### Card Run

`Run card` means:

- compute the card's required upstream dependencies
- execute enabled rows or rows with active output demand
- update outputs owned by the card
- do not run unrelated downstream branches by default

For an integrated card:

```text
Image Processing [Run Card]
  Layer Split      enabled/connected
  Enhance          enabled/connected
  Grade            enabled/connected
  Crop             enabled/connected
  Mask             enabled/connected
  Repair           enabled/connected
```

The product must define whether a row is active by:

- explicit enabled toggle
- output connected
- manual run request
- cached result exists and user requests refresh

Do not run every row just because the card exists.

### Run To Node

`Run to node` means:

```text
run all transitive upstream dependencies
then run this node/card
stop here
```

This is the cleanest way to answer:

```text
I want to see this card's current result.
```

It should be available from:

- node/card context menu
- selected card action
- inspector/action drawer if open

### Run Downstream

`Run downstream` means:

```text
start from this node/card/row output
run consumers downstream from here
```

This must be explicit because downstream execution can be expensive and may
trigger API calls, model runs, export, video render, or audio processing.

### Run Selection

Selection run is useful after the user box-selects several cards.

Recommended menu:

```text
Run selected with upstream
Run selected only
Run downstream from selection
```

Default should be `Run selected with upstream`, because most selected cards
still need their inputs.

`Run selected only` should warn or fail clearly if required inputs are missing.

### Run Full Canvas

The existing global run remains:

```text
Run active canvas
```

It should run the current canvas according to the graph's target/output rules,
not every possible hidden row or stale branch.

## Scope Vocabulary

Use an explicit scope model:

```ts
type RunScope =
  | { kind: "full_canvas"; canvasId: string }
  | { kind: "node_upstream"; canvasId: string; nodeId: string }
  | { kind: "node_downstream"; canvasId: string; nodeId: string }
  | { kind: "selection_with_upstream"; canvasId: string; nodeIds: string[] }
  | { kind: "selection_only"; canvasId: string; nodeIds: string[] }
  | { kind: "card"; canvasId: string; nodeId: string }
  | { kind: "card_row"; canvasId: string; nodeId: string; rowId: string };
```

This keeps UI entry points independent from implementation. A row button, a
context menu command, or a future automation trigger can all produce a
`RunScope`.

## Integrated Card Row Execution

For integrated cards that lower into hidden leaf nodes, row run needs a stable
contract:

```text
visible card row
  -> row id
  -> hidden leaf executor
  -> row params
  -> selected backend ref
  -> output cache/result
```

The row should not require a fake edge just to be considered executable.

For `Image Processing`, a future product shape may use card-level input:

```text
Image Processing.image
Image Processing.prompt optional
```

Then row execution maps internally:

```text
Run Enhance
  card.image -> imageEnhance.image
  enhance params -> imageEnhance params
  enhance backend selection -> executor
  imageEnhance.enhanced_image -> enhance row result
```

This avoids forcing the user to connect the same image into every row.

## Dependency Rules

### Upstream Dependencies

Most scoped runs should include upstream dependencies by default.

Example:

```text
Image Source -> Image Processing -> Preview
```

Running `Image Processing / Enhance` should resolve the image source first if
needed.

### Downstream Consumers

Downstream should not run unless explicitly requested.

Reason:

- downstream may include API generation
- downstream may include export
- downstream may include video render
- downstream may include expensive local model inference

The user should choose `Run downstream` or `Run full canvas` for that.

### External Connected Cards

If a scoped run depends on a card outside the visual selection or future zone,
the upstream dependency should still run when the selected scope requires it.

Visual grouping should not silently break data dependencies.

## UI Affordances

### Row-Level Buttons

For dense cards, row run controls should be compact:

```text
Enhance        [run icon]
Mask / Matte   [run icon]
Repair         [run icon]
```

The row button should use a tooltip naming the scope:

```text
Run Enhance row
Run Mask / Matte row
```

### Card-Level Button

The card title/header can expose:

```text
Run card
Open settings
```

Do not overload the settings/inspector button as the run button.

### Context Menu

Node/card context menu should include:

```text
Run to here
Run card
Run downstream
```

Rows can expose row-specific context actions later if needed.

### Toolbar

The toolbar should continue to own global/selection commands:

```text
Run active canvas
Run selected with upstream
Run downstream from selection
Cancel
Logs
```

Toolbar commands should operate on selection or canvas state, not invent a new
graph structure.

## Future Reference: Execution Zones

Execution zones can be reconsidered later as `Stage` or `Execution Group`.

If implemented, they should be organizational first:

```text
Stage: Product cleanup
Stage: Generate variants
Stage: Export
```

Rules required before building:

- whether zone run includes upstream outside the zone
- whether downstream outside the zone is excluded by default
- how cards shared by multiple zones behave
- how saved workflow JSON represents zones
- whether zones are visual-only or executable entities

Until these rules are settled, do not make zones the first run-scope feature.

## Future Reference: Execution Nodes

Execution nodes should be reserved for automation triggers, not ordinary manual
run control.

Possible future examples:

```text
Schedule Trigger
Webhook Trigger
Watch Folder Trigger
Batch Trigger
Export Trigger
```

They should not be required for:

- running a card
- running a row
- running to a selected node
- running a selected group

## Implementation Order

1. ✅ Define the `RunScope` type and scope resolver
   (`studio-ui/src/runtime/runScope.ts`): `resolveRunScope` turns a scope +
   authored graph into the subgraph to execute (upstream included by default,
   downstream only for `node_downstream`, `selection_only` warns about cut
   inputs; `card_row` resolves to the card's upstream chain until row
   narrowing lands).
2. ✅ Normalize existing `runUpToNode` under `RunScope.node_upstream`: the run
   controller's `run` / `runUpToNode` now build scopes and share one
   `runScope(scope)` pipeline, which is also exposed on the controller for
   future selection/card/downstream affordances.
3. ✅ Add row-level run for integrated cards, starting with `Image Processing`:
   `card_row` now narrows for real — the resolver keeps only the card edges of
   the row's `<rowId>.` port prefix before taking the ancestor subgraph, so
   lowering produces just that row's leaf and only its input chain runs (a
   warning is logged when the row has no wired input). Every paired semantic
   row on an integrated card shows a hover run button (`NodeCardShell`
   `onRunRow` → `runCardRow` on the run controller / editing context).
4. ✅ Reuse existing backend ref validation for row/card scoped runs: every
   scoped run already flows through the shared `runScope` pipeline (and so
   through `validateBackendRefs`); `card_row` runs additionally pass a
   `rowFilter` so only the running row's bindings are checked — the other
   rows of the card do not execute, so their refs are irrelevant.
5. ✅ Add card-level run for integrated cards: `runCard` on the run
   controller / editing context (RunScope `card` — the card's wired rows plus
   upstream), surfaced as a ▶ button in the card header of integrated cards
   next to the status dot.
6. ✅ Add toolbar/context menu commands for selection run: the toolbar run
   group shows "Run selected (n)" whenever nodes are selected
   (`selection_with_upstream`), and the node context menu gained "Run to
   here" / "Run card" (integrated cards only).
7. ✅ Add explicit downstream run: "Run downstream" in the node context menu
   (`runNodeDownstream` → RunScope `node_downstream`); downstream still never
   runs implicitly from any other affordance.
8. ✅ Add clear run reports showing scope, executed nodes/rows, skipped rows,
   and backend/device reports: once a scope is resolved and lowered, the run
   log gets a pre-execution report (`buildRunReport` in `runReport.ts`) with
   the scope + node/row counts, each integrated card's running vs. skipped
   rows, and the API-profile / local-model refs (with device/precision
   policies) carried by the executing nodes.
9. Only then revisit execution zones or execution nodes — deferred; see
   "Future Reference" sections above for the rules that must be settled first.

## Success Criteria

The user can:

1. Run one row of `Image Processing` without running sibling rows.
2. Run a whole processing card without running unrelated downstream branches.
3. Run to a selected node to refresh its result.
4. Box-select cards and run them with upstream dependencies.
5. Choose downstream execution explicitly when they want propagation.
6. Understand from the UI what will run before expensive API/model/export work
   starts.

Execution becomes predictable without adding new graph clutter.
