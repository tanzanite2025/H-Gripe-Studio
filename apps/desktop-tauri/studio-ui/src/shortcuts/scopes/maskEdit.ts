// Photoshop-aligned shortcut bindings for the Mask-Edit modal scope
// (see `../core.ts` for the scope-stack system these register into).
//
// Combos follow Photoshop where the tool exists here; combos for tools we do
// not have yet are reserved as `planned` (documented, never dispatched) so
// future work lands on the PS key without a migration. This is the frozen
// scope table for `scope: "mask-edit"`.

import type { ShortcutBinding } from "../core";

export const MASK_EDIT_SCOPE = "mask-edit";

export const MASK_EDIT_SHORTCUTS: readonly ShortcutBinding[] = [
  // Tool selection (PS single letters).
  { id: "tool_brush", combo: "b", status: "ready", hint: "Brush tool." },
  { id: "tool_eraser", combo: "e", status: "ready", hint: "Eraser tool." },
  { id: "tool_wand", combo: "w", status: "ready", hint: "Magic wand tool." },
  { id: "tool_pen", combo: "p", status: "ready", hint: "Pen tool." },
  { id: "tool_lasso", combo: "l", status: "ready", hint: "Lasso tool." },
  { id: "tool_rect", combo: "m", status: "ready", hint: "Rectangular marquee." },
  { id: "tool_ellipse", combo: "shift+m", status: "ready", hint: "Elliptical marquee (PS cycles marquees with Shift+M)." },
  // Editing.
  { id: "undo", combo: "ctrl+z", status: "ready", hint: "Undo the last edit." },
  { id: "redo", combo: "ctrl+shift+z", status: "ready", hint: "Redo." },
  { id: "redo_alt", combo: "ctrl+y", status: "ready", hint: "Redo (alternate)." },
  { id: "clear", combo: "ctrl+d", status: "ready", hint: "Clear all edits (PS Deselect)." },
  { id: "invert", combo: "ctrl+shift+i", status: "ready", hint: "Invert the mask (PS Inverse selection)." },
  // Brush / path controls.
  { id: "brush_smaller", combo: "[", status: "ready", hint: "Decrease brush size." },
  { id: "brush_larger", combo: "]", status: "ready", hint: "Increase brush size." },
  { id: "swap_mode", combo: "x", status: "ready", hint: "Swap add/subtract: brush ↔ eraser, path mode add ↔ subtract (PS swap colours)." },
  { id: "close_path", combo: "enter", status: "ready", hint: "Close the pending pen path (PS closes/commits a path with Enter)." },
  { id: "cancel", combo: "escape", status: "ready", hint: "Cancel the pending pen path; pressed again, close the editor." },
  // View.
  { id: "toggle_overlay", combo: "ctrl+h", status: "ready", hint: "Toggle mask-only view (PS Hide Extras)." },
  // Reserved PS combos for tools that are not implemented yet. `planned`
  // bindings are never dispatched; they only reserve the key against future
  // conflicts and show in the cheat sheet as coming soon.
  { id: "tool_zoom", combo: "z", status: "planned", hint: "Zoom tool (planned)." },
  { id: "tool_hand", combo: "h", status: "planned", hint: "Hand / pan tool (planned)." },
  { id: "tool_crop", combo: "c", status: "planned", hint: "Crop tool (planned)." },
  { id: "quick_mask", combo: "q", status: "planned", hint: "Quick-mask preview toggle (planned)." },
  { id: "free_transform", combo: "ctrl+t", status: "planned", hint: "Free transform (planned)." },
  { id: "feather_dialog", combo: "shift+f6", status: "planned", hint: "Feather dialog (planned; feather is a toolbar op today)." },
] as const;

/** The combo a toolbar tool is bound to (for tooltips), if any. */
const TOOL_COMBO: Readonly<Record<string, string>> = {
  brush: "b",
  eraser: "e",
  wand: "w",
  pen: "p",
  lasso: "l",
  rect: "m",
  ellipse: "shift+m",
};

export function toolCombo(toolId: string): string | undefined {
  return TOOL_COMBO[toolId];
}
