# Prompt Assistant System Plan

> Historical note (2026-07-16): local inference and downloadable-engine UI described below were retired. The current product keeps deterministic native operations and sends model-backed work through API profiles. Treat the remaining text as implementation history, not current guidance.


> Status: complete. All nine implementation-path steps landed (PRs #521–#526):
> the assistant launcher (now a draggable always-on-top floating button with the
> eyes icon, #527–#529), the draggable docked panel, local + API-profile + local
> -model backends, target-aware insertion, the Prompt card Assistant row, and
> the removal of the legacy `prompt` primitive. The inline card model row was
> later removed (#530); model selection lives in the assistant panel and
> Inspector.
> Purpose: define the software-level assistant / prompt conversation surface so
> prompt creation does not get trapped inside canvas node cards.

## Core Decision

Prompt creation is a software-level workflow, not a canvas-node-only workflow.

The canvas `Prompt` node is only the final text source that feeds the graph. It
should stay simple: text in, text out. It must not become a full chat client,
API-key editor, local-model manager, prompt history database, and node all at
once.

H-Gripe Studio needs a resident **Prompt Assistant** system:

```text
Prompt Assistant
  -> choose API profile or local model
  -> multi-turn conversation / rewrite / translate / structure / style
  -> produce prompt drafts
  -> insert selected text into Prompt / Generate nodes
```

The assistant helps the user create usable prompt text. The graph consumes the
confirmed prompt text.

## Placement

Do not put Prompt Assistant inside the bottom production drawer.

The bottom drawer is reserved for:

- Edit / Timeline
- Grade

When video editing expands upward, any assistant panel living in the bottom
drawer will fight the timeline and grading workspace. The assistant must remain
reachable even while the bottom drawer is open.

Recommended shell:

```text
Right tool rail
  P  Prompt Assistant
  A  Assets / references
  H  History
  S  Settings

Prompt Assistant opens as:
  - an attached right panel, or
  - a floating panel that can dock to the right edge,
  - with remembered size and position.
```

When unused, only the narrow right rail remains. When used, the Prompt Assistant
panel opens above the canvas and avoids the bottom drawer area.

## Layering Rules

Prompt Assistant is not a graph node.

It may read the current graph selection, but it must not become part of graph
execution unless the user explicitly inserts text into a node.

| Surface | Role |
| --- | --- |
| Prompt Assistant panel | Conversation, drafting, rewriting, model selection, prompt library. |
| `Prompt` node | Stores final text as a graph input and owns optional prompt optimization rows. |
| `Generate` node | Consumes prompt text and calls image generation. |
| API Manager | Owns provider profiles and credentials. |
| Local Model Manager | Owns installed local text / vision helper models. |

This split keeps the canvas clean and keeps assistant state from polluting the
serializable workflow graph.

There must not be a separate user-facing `Prompt Optimize` card. A single graph
area should not expose two different prompt concepts. Prompt optimization is an
operation inside the owning `Prompt` card, not another visible prompt card in
the palette.

Recommended `Prompt` card shape:

| Row | Role |
| --- | --- |
| Prompt Text | The confirmed prompt that flows into Generate or other downstream cards. |
| Optimize | Optional rewrite/translate/structure operation for the prompt text. |
| Backend | Compact selector for API profile or local model with prompt/text capability. |
| Assistant | Button that opens the software-level Prompt Assistant panel for deeper conversation. |

The `Optimize` row can expose a connectable output if the graph needs both raw
and optimized prompt variants, but the visual owner is still the `Prompt` card.
The palette should show one prompt entry: `Prompt`.

## Prompt Assistant Capabilities

First version:

- multi-turn conversation
- free text prompt drafting
- Chinese / English rewrite
- style expansion
- negative prompt drafting when the target card supports it
- one-click insert into selected Prompt node
- one-click create new Prompt node from current draft
- copy current draft
- keep local session history

Later:

- prompt templates / presets
- project prompt library
- reference-image-aware prompt drafting
- layered-asset-aware prompt drafting
- target-aware suggestions for Generate / Image Processing / Layered Asset
- compare prompt drafts
- save favorite prompt snippets

## Model Selection

The assistant can use API or local models, but it should not store raw provider
configuration itself.

It should reference global managers:

```text
Prompt Assistant
  selected_backend:
    kind: "api_profile" | "local_model"
    ref: string
```

Examples:

```text
api_profile: openai-compatible-main
local_model: qwen2.5-coder-7b-instruct
local_model: small-prompt-rewriter
```

The assistant panel can show a compact selector:

```text
Backend: [API: OpenAI Compatible / gpt-4o-mini v]
         [Configure]
```

or:

```text
Backend: [Local: Prompt Rewriter Small v]
         [Manage Models]
```

The configure buttons open the global API Manager or Local Model Manager.

## Insert Targets

The assistant should support explicit insert actions instead of silently writing
into the graph.

Recommended actions:

| Action | Behavior |
| --- | --- |
| Insert into selected Prompt node | Replaces or appends to selected `Prompt` node text. |
| Create Prompt node | Creates a new `Prompt` node near current canvas focus. |
| Send to selected Generate node | Writes prompt text into connected prompt source or creates one. |
| Copy | Copies draft to clipboard without graph mutation. |

If no valid target exists, the primary action should be `Create Prompt node`.

## Conversation State

Assistant conversation state is not the workflow graph.

Store it separately:

```ts
interface PromptAssistantSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  backendRef: { kind: "api_profile" | "local_model"; ref: string };
  messages: PromptAssistantMessage[];
  drafts: PromptDraft[];
  linkedProjectId?: string;
}
```

The graph should only receive the final prompt text the user inserts.

This avoids making graph runs depend on an informal chat transcript.

## Relation To Prompt Card Optimization

Prompt Assistant and the `Prompt` card's `Optimize` row solve different
problems.

Prompt Assistant:

- interactive
- exploratory
- multi-turn
- software-level UI
- not part of DAG execution

`Prompt` card `Optimize` row:

- deterministic graph step
- saved with workflow
- runs during graph execution
- can be cached / reproduced
- can select an API profile or local model through the global managers
- can open Prompt Assistant for exploratory drafting when the user needs a
  conversation instead of a one-shot rewrite

Both can use the same API/local model managers, but they are not the same
surface. The assistant is the software-level window/panel; the `Prompt` card is
the graph-level source of prompt text.

Implementation order:

1. Build or stabilize the global API Manager and Local Model Manager described
   in [`API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md).
2. Build the software-level Prompt Assistant panel described in this document.
3. Update the `Prompt` card so it has one prompt text area plus an optional
   `Optimize` row.
4. Wire the `Optimize` row to the same backend refs used by the managers and
   assistant.
5. Remove or hide any user-facing `Prompt Optimize` card from the normal
   palette. Keep old workflow loading as a migration/backcompat concern only.

## UI Contract

The assistant should be available even when:

- bottom production drawer is open
- timeline is expanded
- grade panel is active
- image editor modal is closed
- no canvas node is selected

The right rail must remain clickable. The assistant panel should avoid covering
critical timeline controls when the bottom drawer is open.

Suggested layout:

```text
Canvas area
  right rail always visible
  assistant panel docks/floats from right

Bottom drawer
  edit/timeline + grade only
```

## Non-Goals

- Do not turn the `Prompt` node into a chat UI.
- Do not expose a separate user-facing `Prompt Optimize` card.
- Do not store API keys inside assistant sessions.
- Do not make the assistant transcript part of graph execution.
- Do not put the assistant inside the bottom production drawer.
- Do not force every prompt draft to create a graph node.

## Implementation Path

1. ✅ Add right tool rail shell with a Prompt Assistant entry
   (`studio-ui/src/assistant/ToolRail.tsx`: fixed right rail, `P` entry,
   open state persisted).
2. ✅ Add Prompt Assistant floating/docked panel with local-only mock
   conversation (`PromptAssistantPanel.tsx`: docked right panel above the
   bottom drawer; the "backend" is the deterministic local rewriter shared
   with the `promptOptimize` card's `local` mode, preset selectable; session
   persists in localStorage via `promptAssistantState.ts`, separate from
   workflow persistence).
3. ✅ Add insert actions for selected Prompt node and create Prompt node
   (insert writes the draft into the selected `prompt` / `promptOptimize`
   card's `text` param; create spawns a selected `promptOptimize` card with
   the draft; plus copy-to-clipboard and clear-session).
4. ✅ Wire API profile selection through the global API Manager
   (panel backend select goes through the same capability-filtered selector
   API as cards — `apiProfilesFor(registry, "prompt.rewrite")` — with a
   Manage button opening the shared `ModelManagerModal`; replies run the same
   `text.generate` broker task as the `promptOptimize` card's `api` mode via
   `assistantApiReply`; the session stores only `{ kind: "api_profile", ref }`,
   never provider URLs or keys; failures surface as assistant turns).
5. ✅ Wire local text model selection through the Local Model Manager
   (backend select lists `localModelsFor(registry, "prompt.rewrite")` next to
   API profiles; the session stores `{ kind: "local_model", ref }`. Managed
   local models draft via the built-in rewriter — with a visible note — until
   the local text engine lands, matching the Prompt card's local behaviour).
6. ✅ Add session persistence separate from workflow graph persistence
   (localStorage-backed session in `promptAssistantState.ts`; multi-session
   history remains future work).
7. ✅ Add target-aware prompt insertion for Prompt and Generate cards
   (`insertTarget.ts`: Prompt / Prompt Optimize cards take the draft in their
   `text` param; a selected Generate card routes the draft to the Prompt card
   feeding its `prompt` input, wires in a fresh Prompt card when the input is
   free, and refuses — with a status message — when a non-prompt node owns it).
8. ✅ Add the `Prompt` card `Optimize` row using the same manager-backed backend
   refs (the palette `Prompt` card — kind `promptOptimize` — already carries
   the Optimize/Backend rows via its `model_select` control /
   `PromptModelSelect`, which mirrors manager refs into the legacy
   mode/ref params; this step completes the recommended card shape with the
   `Assistant` row: a card button — `editing.openAssistant` — that opens the
   software-level panel with the card selected as the insert target).
9. ✅ Remove the old prompt primitive entirely (no pre-launch backcompat
   needed): the palette already showed a single `Prompt` entry (kind
   `promptOptimize`); the legacy internal `prompt` kind was deleted from
   `nodeSpecs.ts` / `defaultExecutors` / the Rust `node_registry` + graph
   executor, and every spawner (sample workflow, assistant wire-new) now
   creates `promptOptimize` cards.

## Success Criteria

The user can:

1. Open Prompt Assistant from the right rail while the bottom drawer is open.
2. Choose API or local model backend.
3. Talk through several prompt revisions.
4. Insert the chosen result into a Prompt node.
5. Run the graph without the assistant transcript becoming part of the DAG.

The canvas stays clean, and prompt creation becomes a first-class studio tool.
