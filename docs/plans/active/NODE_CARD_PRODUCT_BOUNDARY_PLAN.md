# Node Card Product Boundary Plan

> Status: active.
> Purpose: keep the node canvas product-facing, not a low-level programming
> canvas. A node card must represent a meaningful production operation, not a
> tiny implementation primitive.

## Core Decision

The node editor is the main canvas, but it must not become a ComfyUI-style pile
of tiny logic blocks.

A visible node card must answer:

```text
What production action does this card complete for the user?
```

If the answer is only "provide a number", "compare two values", "choose a
branch", "route a wire", or "hold a small helper value", it is not a
product-facing card. That behavior belongs inside the card that needs it.

## Card Boundary Rule

Visible cards are allowed when they represent one of these user-facing objects
or operations:

| Card Type | Examples | Why It Can Be A Card |
| --- | --- | --- |
| Source / asset | Image Source, Video Source, PSD Template, Prompt | The user is placing an input object on the canvas. |
| Production operation | Generate, Image Processing, Layered Asset Review | The card performs a real media/model/edit step at a useful product level. |
| Review / gate | Layer review, mask preview, defect review | The card asks the user to confirm or correct a meaningful result. |
| Export / sink | Export, PSD Export, Video Assemble | The card produces a deliverable. |
| Batch / workflow-level operation | Batch | The card changes how the graph is executed, not a tiny parameter. |

Visible cards are not allowed when they are only implementation primitives:

| Primitive | Product Treatment |
| --- | --- |
| Number | A field inside the owning card: seed, steps, crop margin, grade value, batch count, threshold, frame index. |
| Compare | A rule row inside the owning card: "only repaint if quality < target", "only split if confidence > threshold". |
| Logic | A rule group inside the owning card: all/any/not conditions, hidden behind a readable UI. |
| If | A card-level condition or run policy, not a separate block. |
| Switch | A mode selector, route selector, or strategy selector inside the owning card. |
| Reroute | A canvas wire tool / edge gesture, not a node card. |

The code may keep internal primitive node kinds for saved workflow compatibility
and runtime lowering, but the default palette must not expose them as products.

## Ownership Mapping

### Generate Card

Owns numeric and mode values such as:

- seed
- steps
- size
- operation
- provider/model
- reference image behavior

It should not require a standalone Number card for seed or steps. The port can
still accept an override for automation, but the normal UI is the Generate
card's own fields.

### Prompt Card

There should be one visible prompt card, not both `Prompt` and `Prompt
Optimize`.

Prompt optimization is a row inside the owning `Prompt` card. The card owns:

- prompt text
- negative prompt text when the downstream target supports it
- optional `Optimize` row
- API/local backend selector for prompt rewrite/translation/structuring
- a button that opens the software-level Prompt Assistant panel

The Prompt Assistant itself is not a graph card. It is planned as a
software-level panel/window in
[`PROMPT_ASSISTANT_SYSTEM_PLAN.md`](../completed/PROMPT_ASSISTANT_SYSTEM_PLAN.md), and it
uses shared API/local backend refs from
[`API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md`](../completed/API_AND_LOCAL_MODEL_MANAGEMENT_PLAN.md).

The implementation order should be:

1. Keep one visible `Prompt` palette entry.
2. Add the `Prompt` card's internal `Optimize` row.
3. Connect that row to API/local model managers for backend selection.
4. Add the button that opens Prompt Assistant for deeper conversation.
5. Hide or migrate any old `Prompt Optimize` card as internal/backcompat only.

If the graph needs both raw prompt and optimized prompt outputs, expose two
semantic row outputs from the same `Prompt` card, such as `prompt.raw` and
`prompt.optimized`. Do not create a second prompt card just to represent the
optimization step.

### Image Processing Card

Image work should be gathered into one product-facing processing card instead
of scattering one card per small operation.

The card body is a row-based panel:

| Row | Row Input | Row Output | Role |
| --- | --- | --- | --- |
| Layer Split | image | layered image | Compute a layered asset for review / downstream nodes. |
| Enhance | image | enhanced image | Parameterized quality enhancement. |
| Grade | image or layer | graded image | Reusable colour operation backed by `hgripe-grade`. |
| Crop / Transform | image | cropped image | Parameterized crop / transform operation. |
| Mask / Matte | image | mask / cutout / alpha | Parameterized matte output for downstream use. |
| Repair / Repaint | image + optional report | repaired image | Parameterized repair output. |

Each row can expose its own input/output connection dots. If the user wants to
grade, they connect to the Grade row. If they want crop, they connect to the
Crop row. The canvas shows one coherent Image Processing card, while the
inside of the card makes the available image operations obvious.

Free manual editing does not live on every Image Processing row. It belongs to
the Image Source card itself: the bottom `Edit` action opens the full image
editor, and the user can crop, mask, paint, retouch, adjust layers, or make any
other free edit there. Confirming that editor produces a traceable edited image
asset / output without mutating the original source.

Preview is also not a node-card implementation detail. A node, row, or output
may expose a `Preview` action, but that action opens the shared software-level
preview modal. The preview modal can show source/result/mask/cutout layers and
offer quick operations such as crop, mask, grade, or matte preview, but those
operations must call the same Studio Action / compute-block layer used by the
full image editor.

### Editor / Preview Boundary

Node context must not become the image editor's display source.

The correct split is:

- Preview/review surfaces may present `node_output`, row-port, layer, or mask
  targets because their job is to inspect a graph artifact.
- Software-level editors receive `imagePath` / asset refs for their main
  underlay and may also receive `nodeId` as opening/commit context.
- Saving from an editor returns through the caller's commit callback and folds
  back into node params or creates a new artifact.

`nodeId` therefore means "who opened me / where do I commit back", not "replace
my canvas with a node-output viewport target". This keeps the editor stable
when node artifacts are still registering, have stale ports, or are being
recomputed.

Correct ownership:

```text
node card / row
  -> opens preview with assetId / node_output / row port / layer / mask target
  -> opens editor with imagePath or asset ref plus optional commit context
  -> shared action/kernel layer performs the work
  -> result returns as an artifact or committed edit
```

Wrong ownership:

```text
node card
  -> embeds a second mini image editor
  -> owns private crop/mask/grade logic
  -> mutates pixels without target/preview/undo
```

Image Processing rows are for flow-level, connectable operations. They expose
row-specific input/output ports and parameters so the user can wire exactly the
operation they want. They can provide preview/review affordances, but they should
not redefine the free image editor row by row.

Row ports must be semantically aligned with the row, not auto-spaced by total
port count. A Grade connection dot must sit on the Grade row; a Crop connection
dot must sit on the Crop row. Ports should have stable semantic ids such as
`grade.in`, `grade.out`, `crop.in`, `crop.out`, `mask.out`, and
`layerSplit.out`.

The old leaf node kinds such as `subjectMask`, `crop`, `imageGrade`,
`imageEnhance`, `detailWatchdog`, and `detailRepaint` may remain as internal
runtime/backcompat steps. The palette should move toward the Image Processing
card as the visible entry point.

### Layer Split / Layer Review

Owns splitting strategy, confidence thresholds, protected layer rules, and
review gating.

Internal compare/logic behavior belongs here as readable controls:

- "protect text/logo candidates"
- "merge tiny fragments below threshold"
- "send uncertain layers to review"
- "auto-accept when confidence is high"

The user should see layer intent and review controls, not If/Switch/Compare
blocks.

### Subject Mask / Matte Card

Owns mask engine, threshold, edge refine behavior, auto/manual handoff, and
edit paths.

Any condition such as "if mask confidence is low, open review" is a card policy.
It should appear as a clear mode or review option inside the mask card.

### Crop / Transform Card

Owns crop mode, aspect, margin, crop box, rotate/transform values.

Number-like values are card fields. Auto/manual choice is a mode selector inside
the card or editor, not a Switch card.

### Grade Card / Grade Panel

Owns exposure, contrast, levels, curves, HSL, LUT, wheels, keyframes, and target
selection.

Numeric controls are sliders/fields inside the Grade card or Grade panel. Video
clip grade and image grade share the same `hgripe-grade` kernel; the difference
is target/time/keyframes, not a separate logic graph.

### Image Enhance / Detail Watchdog / Detail Repaint

Own quality thresholds, repair strategy, model choice, and review policy.

Rules like "only repaint when defect score exceeds threshold" belong inside
these cards as human-readable policy rows.

### Timeline / Video / Audio

Timeline behavior belongs in the Edit / Timeline workspace and its clip menus.

Audio edit opens from audio clips on demand. Video trim/grade/export belong to
timeline target operations. These should not require low-level branching cards
on the main node canvas.

### Wire Cleanup

Wire cleanup is a canvas affordance:

- bend point / waypoint
- edge handle
- auto-route
- tidy selection

It is not a production node. If a saved workflow already contains `reroute`, it
can continue to load, but new users should not see "Reroute" as a card option.

## UI Contract For The Palette

The default node palette should show production cards only.

It should not show:

- Number
- Compare
- Logic
- If
- Switch
- Reroute
- Prompt Optimize

If developer debugging ever needs these primitives, use a dev-only surface or
debug command. Do not add a normal "Advanced nodes" shelf that makes them look
like product features.

## Runtime Contract

Internal primitive kinds may still exist for:

- loading old saved workflows
- lowering card-level policies into executable graph steps
- tests
- migration tooling

But product code should prefer:

```text
visible production card
  -> readable params / ports / context menu / editor state
  -> internal runtime policy
  -> optional lowering to hidden primitive nodes
```

The user-facing canvas should stay at the production level.

## Implementation Path

1. Mark primitive node specs as `palette: "internal"` and filter them from the
   default palette.
2. Keep tests proving these kinds still exist but do not appear in the palette.
3. Audit remaining utility-looking cards. If they do not represent a production
   action, move their behavior into the owning card or the canvas chrome.
4. For each production card, make the owning controls explicit:
   - Generate owns seed/steps/mode.
   - Prompt owns prompt text, optional optimize row, model/API selector, and the
     Prompt Assistant entry.
   - Image Source owns the bottom free `Edit` entry.
   - Image Processing owns row-level ports for split/enhance/grade/crop/mask/repair.
   - Layer Split owns thresholds/review rules.
   - Mask row owns confidence/review/refine policy.
   - Crop row owns aspect/margin/box/auto mode.
   - Grade row owns all color numeric controls.
   - Timeline owns clip routing and audio/video edit entry points.
5. Only after the ownership is clear, add richer card bodies and context menus.

## Success Criteria

The node palette should read like a studio tool:

```text
Image Source -> Image Processing(split/grade/crop/mask rows) -> Export
Prompt(text/optimize rows) -> Generate -> Image Processing(enhance/repair rows) -> Export
Video Source -> Timeline / Grade / Assemble
```

It should not read like:

```text
Number -> Compare -> Logic -> If -> Switch -> Reroute
Prompt -> Prompt Optimize -> Generate
```

The first version helps a creator build a production workflow. The second
version makes the user debug our implementation model.
