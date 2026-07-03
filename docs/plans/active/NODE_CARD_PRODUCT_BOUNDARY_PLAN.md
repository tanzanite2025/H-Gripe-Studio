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

### Image Processing Card

Image work should be gathered into one product-facing processing card instead
of scattering one card per small operation.

The card body is a row-based panel:

| Row | Row Input | Row Output | Manual Entry |
| --- | --- | --- | --- |
| Layer Split | image | layered image | Open layer review / image editor |
| Enhance | image | enhanced image | Optional compare/review |
| Grade | image or layer | graded image | Open Grade panel / grade popup |
| Crop / Transform | image | cropped image | Open crop/transform editor |
| Mask / Matte | image | mask / cutout / alpha | Open mask editor |
| Repair / Repaint | image + optional report | repaired image | Open repair editor |

Each row can expose its own input/output connection dots. If the user wants to
grade, they connect to the Grade row. If they want crop, they connect to the
Crop row. The canvas shows one coherent Image Processing card, while the
inside of the card makes the available image operations obvious.

Manual work should not become separate random cards. Manual edit opens the
existing image editor/modal from the row or image target, records the operation
stack, and writes the confirmed result back to that row's output.

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
   - Smart Layer Split owns thresholds/review rules.
   - Mask owns confidence/review/refine policy.
   - Crop owns aspect/margin/box/auto mode.
   - Grade owns all color numeric controls.
   - Timeline owns clip routing and audio/video edit entry points.
5. Only after the ownership is clear, add richer card bodies and context menus.

## Success Criteria

The node palette should read like a studio tool:

```text
Image Source -> Smart Layer Split -> Review -> Grade -> Export
Prompt -> Generate -> Mask/Crop/Enhance -> Export
Video Source -> Timeline / Grade / Assemble
```

It should not read like:

```text
Number -> Compare -> Logic -> If -> Switch -> Reroute
```

The first version helps a creator build a production workflow. The second
version makes the user debug our implementation model.
