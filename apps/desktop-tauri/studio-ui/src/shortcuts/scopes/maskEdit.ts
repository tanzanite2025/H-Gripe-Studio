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
  { id: "tool_lasso", combo: "l", status: "ready", hint: "Magnetic lasso tool." },
  { id: "tool_rect", combo: "m", status: "ready", hint: "Rectangular marquee." },
  { id: "tool_ellipse", combo: "shift+m", status: "ready", hint: "Elliptical marquee (PS cycles marquees with Shift+M)." },
  // Editing.
  { id: "undo", combo: "ctrl+z", status: "ready", hint: "Undo the last edit." },
  { id: "redo", combo: "ctrl+shift+z", status: "ready", hint: "Redo." },
  { id: "redo_alt", combo: "ctrl+y", status: "ready", hint: "Redo (alternate)." },
  { id: "clear", combo: "ctrl+d", status: "ready", hint: "Deselect the marquee selection; with none, clear all edits (PS Deselect)." },
  { id: "invert", combo: "ctrl+shift+i", status: "ready", hint: "Invert the mask (PS Inverse selection)." },
  { id: "step_backward", combo: "alt+ctrl+z", status: "ready", hint: "Step backward in history (PS legacy undo)." },
  { id: "tool_path_select", combo: "a", status: "ready", hint: "Re-edit the last committed path." },
  // Brush / path controls.
  { id: "brush_smaller", combo: "[", status: "ready", hint: "Decrease brush size." },
  { id: "brush_larger", combo: "]", status: "ready", hint: "Increase brush size." },
  { id: "swap_mode", combo: "x", status: "ready", hint: "Swap add/subtract: brush ↔ eraser, path mode add ↔ subtract (PS swap colours)." },
  { id: "close_path", combo: "enter", status: "ready", hint: "Close the pending pen path (PS closes/commits a path with Enter)." },
  { id: "cancel", combo: "escape", status: "ready", hint: "Cancel the pending pen path; pressed again, close the editor." },
  // View.
  { id: "toggle_overlay", combo: "ctrl+h", status: "ready", hint: "Toggle mask-only view (PS Hide Extras)." },
  // Reserved PS combos for tools / commands that are not implemented yet.
  // `planned` bindings are never dispatched; they only reserve the PS-default
  // key against future conflicts (guarded by the no-conflict CI test) and show
  // in the cheat sheet as coming soon. Full PS default-tool letter map:
  { id: "tool_move", combo: "v", status: "ready", hint: "Move tool (drag to move the mask; Ctrl+T for free transform)." },
  { id: "tool_crop", combo: "c", status: "ready", hint: "Crop tool (drag a box; the mask is cleared outside it)." },
  { id: "tool_frame", combo: "k", status: "planned", hint: "Frame tool (planned)." },
  { id: "tool_eyedropper", combo: "i", status: "ready", hint: "Eyedropper tool (click to sample the image colour under the cursor)." },
  { id: "tool_healing", combo: "j", status: "ready", hint: "Spot-healing brush (paint a region — it's rebuilt from its surroundings)." },
  { id: "tool_clone", combo: "s", status: "ready", hint: "Clone-stamp tool (Alt+click picks the source, then paint copies from it)." },
  { id: "tool_history_brush", combo: "y", status: "ready", hint: "History brush (paint a region back to the layer's initial state)." },
  { id: "tool_gradient", combo: "g", status: "ready", hint: "Gradient tool (drag start → end: a linear selection ramp as a revisable step; Alt-drag subtracts)." },
  { id: "tool_dodge_burn", combo: "o", status: "ready", hint: "Dodge / burn tool (paint lightens the mask, Alt-drag darkens)." },
  { id: "tool_type", combo: "t", status: "planned", hint: "Type tool (planned)." },
  { id: "tool_shape", combo: "u", status: "ready", hint: "Shape tool (drag a box; triangle / polygon / star / line commits as a path step)." },
  { id: "tool_hand", combo: "h", status: "ready", hint: "Hand tool (drag to pan the zoomed view; hold Space with any tool)." },
  { id: "tool_rotate_view", combo: "r", status: "ready", hint: "Rotate-view tool (drag to rotate the view; Esc resets)." },
  { id: "default_colors", combo: "d", status: "ready", hint: "Reset to the default brush / add mode (PS default colours)." },
  { id: "quick_mask", combo: "q", status: "ready", hint: "Toggle the quick-mask (ruby) overlay of the current selection." },
  { id: "screen_mode", combo: "f", status: "ready", hint: "Cycle screen modes: full UI → panels hidden → canvas only (PS full-screen cycle)." },
  // Commands.
  { id: "select_all", combo: "ctrl+a", status: "ready", hint: "Select all (the whole canvas, as a history step)." },
  { id: "reselect", combo: "ctrl+shift+d", status: "ready", hint: "Reselect: restore the selection the last clear dropped." },
  { id: "free_transform", combo: "ctrl+t", status: "ready", hint: "Free transform: move / scale / rotate the mask as a revisable step." },
  { id: "adjust_levels", combo: "ctrl+shift+l", status: "ready", hint: "Add a Levels adjustment layer (PS Levels is Ctrl+L; L is the lasso here)." },
  { id: "adjust_curve", combo: "ctrl+shift+m", status: "ready", hint: "Add a Curve adjustment layer (PS Curves is Ctrl+M; M is the marquee here)." },
  { id: "duplicate", combo: "ctrl+j", status: "ready", hint: "Duplicate the active layer via copy." },
  { id: "fill_dialog", combo: "shift+f5", status: "ready", hint: "Fill dialog: flood the layer at an opacity (add or subtract), as a revisable step (PS Fill)." },
  { id: "image_size", combo: "ctrl+alt+i", status: "ready", hint: "Image Size dialog: set the output pixel size (PS Image Size)." },
  { id: "feather_dialog", combo: "shift+f6", status: "ready", hint: "Feather dialog: set the radius, preview, then apply feather as a revisable step (PS Feather)." },
  { id: "delete_selection", combo: "delete", status: "ready", hint: "Delete the selection (as a history step)." },
  // View / navigation.
  { id: "pan_space", combo: "space", status: "ready", hint: "Hold Space to pan the zoomed view with any tool." },
  { id: "zoom_in", combo: "ctrl+=", status: "ready", hint: "Zoom in." },
  { id: "zoom_out", combo: "ctrl+-", status: "ready", hint: "Zoom out." },
  { id: "zoom_fit", combo: "ctrl+0", status: "ready", hint: "Fit on screen." },
  { id: "zoom_100", combo: "ctrl+1", status: "ready", hint: "100% zoom (one image pixel per screen pixel)." },
  { id: "brush_softer", combo: "shift+[", status: "ready", hint: "Decrease brush hardness (softer edge)." },
  { id: "brush_harder", combo: "shift+]", status: "ready", hint: "Increase brush hardness (harder edge)." },
] as const;

/**
 * The combo a toolbar tool is bound to (tooltips + the toolbar's shortcut
 * badges). Keys are `maskTools` ids; values must stay consistent with the
 * `tool_*` bindings above (guarded by a unit test). Tools with no PS key
 * (SAM point, matting band, the whole-mask operation flyout) are absent.
 */
export const TOOL_COMBO: Readonly<Record<string, string>> = {
  brush: "b",
  eraser: "e",
  wand: "w",
  pen: "p",
  magnetic_lasso: "l",
  rect: "m",
  ellipse: "shift+m",
  move: "v",
  crop: "c",
  gradient: "g",
  hand: "h",
  rotate_view: "r",
  shape: "u",
  eyedropper: "i",
  heal: "j",
  clone: "s",
  history_brush: "y",
  dodge_burn: "o",
};

export function toolCombo(toolId: string): string | undefined {
  return TOOL_COMBO[toolId];
}
