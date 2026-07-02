# Photoshop Toolbar Parity Plan

> Status: planning only. The goal is to preserve Photoshop muscle memory while
> allowing H-Gripe Studio to use its own visual style and AI/workflow extensions.

## Principle

Style can change. Habits cannot.

Photoshop users have years of muscle memory around the left toolbar: tool order,
shared shortcut keys, right-click / long-press flyouts, and contextual tool
options. If H-Gripe Studio changes those habits too much, the editor will feel
unprofessional even if the underlying engine is strong.

The UI rule is:

> Keep Photoshop-compatible placement, grouping, shortcut keys, and flyout
> behaviour. Modernise visual style only after that structure is preserved.

## What Must Match Photoshop

- Left toolbar order should follow Photoshop's tool-slot order.
- A visible toolbar button represents a **tool slot**, not always a single tool.
- Tools sharing a Photoshop shortcut must live in the same flyout slot.
- Right-click and long-press open the flyout.
- Selecting a flyout variant makes that variant the visible slot face.
- Shortcut keys should choose the current slot or cycle variants in that slot.
- Tool options must change with the selected tool.
- Layer / Properties / History panels should remain stable, right-side panel
  concepts rather than random modal content.

## What Can Differ

- Icon drawing style.
- Colours, spacing, hover/active treatment.
- Panel chrome.
- Extra AI-powered tools, as long as they are placed under the closest
  Photoshop-compatible slot or surfaced as separate AI actions outside the core
  toolbar.
- Better tooltips and clearer labels.
- Better performance and preview behaviour.

## What Must Not Happen

- Do not invent a new left-toolbar taxonomy for tools that Photoshop users
  already know.
- Do not put command/filter operations into the left toolbar just because they
  affect pixels or masks.
- Do not move common tools to unfamiliar shortcut groups.
- Do not mix edit/action buttons with core tool slots.
- Do not let a PR make the toolbar look "creative" while breaking muscle memory.

## Toolbar Slot Target

This is the target order for the left toolbar. Some tools can remain disabled or
planned, but their slot position should already be correct.

| Shortcut | Slot | Flyout tools |
| --- | --- | --- |
| `V` | Move | Move |
| `M` | Marquee | Rectangular Marquee, Elliptical Marquee |
| `L` | Lasso | Lasso, Polygonal Lasso, Magnetic Lasso |
| `W` | Selection | Object Selection, Quick Selection, Magic Wand, SAM Point Selection |
| `C` | Crop | Crop, Perspective Crop, Slice, Slice Select |
| `I` | Sample / Measure | Eyedropper, Color Sampler, Ruler |
| `J` | Repair | Spot Healing Brush, Remove Tool, Healing Brush, Patch Tool, Content-Aware Move, Red Eye |
| `B` | Brush | Brush, Pencil, Color Replacement, Mixer Brush |
| `S` | Stamp | Clone Stamp, Pattern Stamp |
| `Y` | History | History Brush, Art History Brush |
| `E` | Eraser | Eraser, Background Eraser, Magic Eraser |
| `G` | Fill / Gradient | Gradient, Paint Bucket |
| `O` | Dodge / Burn | Dodge, Burn, Sponge |
| `P` | Pen | Pen, Freeform Pen, Curvature Pen, Add Anchor, Delete Anchor, Convert Point |
| `T` | Type | Horizontal Type, Vertical Type, Type Mask variants |
| `A` | Path Selection | Path Selection, Direct Selection |
| `U` | Shape | Rectangle, Ellipse, Triangle, Polygon, Line, Custom Shape |
| `H` | Hand | Hand |
| `R` | Rotate View | Rotate View |
| `Z` | Zoom | Zoom |
| none / lower rail | Colours / Screen / Quick Mask | Foreground/background swatches, reset/swap, Quick Mask, screen mode |

## Current Local Mapping

The current implementation has a good toolbar shell:

- `MaskToolbar.tsx`: renders a single icon column with long-press / right-click
  flyouts.
- `toolIcons.tsx`: inline icons per tool id.
- `maskTools.ts`: tool registry and current slots.
- `ToolOptionsPanel.tsx`: contextual options panel.
- `PanelDock.tsx`: right-side tabbed dock groups.

The main correction is not the shell. The correction is the registry taxonomy.

### Keep In The Left Toolbar

These current tools can stay in left toolbar slots, but should be grouped under
Photoshop-compatible slots:

| Current id | Target PS slot |
| --- | --- |
| `move` | `V` Move |
| `rect`, `ellipse` | `M` Marquee |
| `lasso` | `L` Lasso |
| `wand`, `point` | `W` Selection |
| `crop` | `C` Crop |
| `eyedropper` | `I` Sample / Measure |
| `heal` | `J` Repair |
| `brush`, `matting` | `B` Brush, or matting as AI/matte variant if kept in this editor |
| `clone` | `S` Stamp |
| `history_brush` | `Y` History |
| `eraser` | `E` Eraser |
| `gradient` | `G` Fill / Gradient |
| `dodge_burn` | `O` Dodge / Burn |
| `pen` | `P` Pen |
| `shape` | `U` Shape |
| `hand` | `H` Hand |
| `rotate_view` | `R` Rotate View |
| `zoom` | `Z` Zoom |

### Move Out Of The Left Toolbar

These current tools are better treated as mask operations, properties, or
adjustments. They should not occupy a core Photoshop-style left toolbar slot:

| Current id | Better home |
| --- | --- |
| `invert` | Right panel: Mask Ops / Properties |
| `fill_holes` | Right panel: Mask Ops |
| `smooth` | Right panel: Mask Ops |
| `grow` | Right panel: Mask Ops |
| `shrink` | Right panel: Mask Ops |
| `feather` | Right panel: Mask Ops / Properties |
| `blur` | Right panel: Filters / Mask Ops |
| `sharpen` | Right panel: Filters / Mask Ops |

Rule of thumb:

> Left toolbar = the tool currently in the user's hand.
> Right panel / menu = operations applied to the selected layer, mask, or object.

## Proposed Registry Shape

The registry should model Photoshop slots directly. Instead of only listing raw
tools, define slots with shortcut, face memory, and variants.

```ts
type PsToolSlot = {
  id: string;
  shortcut?: string;
  label: string;
  variants: readonly string[];
};

const PS_TOOL_SLOTS: readonly PsToolSlot[] = [
  { id: "move", shortcut: "V", label: "Move", variants: ["move"] },
  { id: "marquee", shortcut: "M", label: "Marquee", variants: ["rect", "ellipse"] },
  { id: "lasso", shortcut: "L", label: "Lasso", variants: ["lasso", "polygon_lasso", "magnetic_lasso"] },
  { id: "selection", shortcut: "W", label: "Selection", variants: ["object_select", "quick_select", "wand", "point"] },
  { id: "crop", shortcut: "C", label: "Crop", variants: ["crop", "perspective_crop", "slice", "slice_select"] },
  { id: "sample", shortcut: "I", label: "Sample", variants: ["eyedropper", "color_sampler", "ruler"] },
  { id: "repair", shortcut: "J", label: "Repair", variants: ["spot_heal", "remove", "healing_brush", "patch", "content_aware_move", "red_eye"] },
  { id: "brush", shortcut: "B", label: "Brush", variants: ["brush", "pencil", "color_replacement", "mixer_brush"] },
  { id: "stamp", shortcut: "S", label: "Stamp", variants: ["clone", "pattern_stamp"] },
  { id: "history", shortcut: "Y", label: "History", variants: ["history_brush", "art_history_brush"] },
  { id: "eraser", shortcut: "E", label: "Eraser", variants: ["eraser", "background_eraser", "magic_eraser"] },
  { id: "fill", shortcut: "G", label: "Fill", variants: ["gradient", "paint_bucket"] },
  { id: "dodge", shortcut: "O", label: "Dodge", variants: ["dodge", "burn", "sponge"] },
  { id: "pen", shortcut: "P", label: "Pen", variants: ["pen", "freeform_pen", "curvature_pen"] },
  { id: "type", shortcut: "T", label: "Type", variants: ["type_horizontal", "type_vertical"] },
  { id: "path_select", shortcut: "A", label: "Path Select", variants: ["path_select", "direct_select"] },
  { id: "shape", shortcut: "U", label: "Shape", variants: ["shape_rect", "shape_ellipse", "shape_triangle", "shape_polygon", "shape_line", "shape_custom"] },
  { id: "hand", shortcut: "H", label: "Hand", variants: ["hand"] },
  { id: "rotate_view", shortcut: "R", label: "Rotate View", variants: ["rotate_view"] },
  { id: "zoom", shortcut: "Z", label: "Zoom", variants: ["zoom"] },
];
```

Unimplemented variants can be registered as `planned` and disabled. Keeping the
slot visible and familiar is more important than pretending the app has a novel
tool order.

## Flyout Behaviour

Flyout behaviour should match the screenshot:

- Right-click on a toolbar slot opens its flyout immediately.
- Long-press opens the same flyout.
- The flyout appears to the right of the toolbar, aligned to the clicked slot.
- Each row shows icon, tool name, and shortcut key.
- The active tool has a check/active marker.
- Clicking a row selects the variant and closes the flyout.
- The selected variant becomes the visible face of that slot.
- Pressing the slot shortcut selects the visible face.
- Pressing the same shortcut repeatedly can optionally cycle variants, matching
  Photoshop's "Shift + shortcut cycles tools" preference later.

## Contextual Tool Options

Do not show one generic options block for every tool.

Target behaviour:

| Tool slot | Options shown |
| --- | --- |
| Move | Auto-select layer, transform controls, align/distribute when multiple layers exist |
| Marquee | New/add/subtract/intersect, feather, style, width/height |
| Lasso | New/add/subtract/intersect, feather, anti-alias |
| Selection/Wand | Tolerance, contiguous, sample all layers, refine/subject model options |
| Crop | Ratio, width/height, straighten, delete/hide cropped pixels |
| Eyedropper | Sample size, current colour swatch |
| Repair | Size, hardness, type/content-aware/source options |
| Brush/Eraser | Size, hardness, opacity/flow, smoothing, target mask/layer |
| Stamp | Source point, aligned, sample mode |
| Gradient/Fill | Gradient preset, mode, opacity, reverse, dither |
| Dodge/Burn | Range, exposure, protect tones |
| Pen/Shape | Path mode, add/subtract/intersect, fill/stroke when shape layers land |
| Hand/Rotate/Zoom | Fit, 100%, reset rotation, zoom mode |

This prevents the UI from feeling like a generic web form. The selected tool
should make the options bar/panel feel intentional.

## Where AI Tools Fit

AI features should enhance Photoshop slots, not break them.

Examples:

- SAM point selection belongs under `W` Selection as an AI selection variant.
- Matting assistance can be a Brush/Selection refinement option, or an AI panel
  action attached to a mask.
- Background removal can be a right-panel quick action, not a random left-toolbar
  tool.
- API/local model nodes remain graph concepts; only direct canvas interactions
  should become toolbar tools.

## Implementation Order

1. Freeze this document as the review standard for toolbar PRs.
2. Refactor the registry into Photoshop slot objects.
3. Add planned disabled variants to preserve PS slot shape.
4. Move whole-mask operations out of the left toolbar into a right-panel `Mask Ops`
   group.
5. Update shortcut metadata so each slot owns its Photoshop key.
6. Update flyout labels to show the slot shortcut like Photoshop.
7. Make tool options conditional per selected tool kind/slot.
8. Fix Simplified Chinese text encoding in `maskToolsI18n.ts`.
9. Add tests that every ready/planned tool appears in exactly one Photoshop slot.
10. Add tests that common Photoshop shortcuts map to the expected slots.

## Review Checklist

Before accepting toolbar-related PRs:

- Does the change preserve Photoshop slot order?
- Does it preserve Photoshop shortcut grouping?
- Does a right-click flyout still expose sibling tools?
- Did any command/filter operation get incorrectly added to the left toolbar?
- Did contextual options stay specific to the selected tool?
- Does the selected flyout variant remain the visible slot face?
- Are unimplemented Photoshop variants disabled rather than omitted when their
  absence would make the toolbar order confusing?
- Does the Chinese UI text render correctly?

## Short-Term Recommendation

For the current local toolbar, do not rewrite the engine. Change the registry
and placement first:

- Keep the existing toolbar component.
- Keep the existing flyout mechanism.
- Keep the existing icons as placeholders if needed.
- Rebuild `MASK_TOOL_SLOTS` around Photoshop slot order.
- Move mask operations to the right panel.
- Make `move` or last-used tool the default for the future full PS workspace;
  keep `brush` default only when the surface is explicitly a mask-only editor.

This gives users the correct muscle memory quickly, while leaving room to polish
the visual style later.
