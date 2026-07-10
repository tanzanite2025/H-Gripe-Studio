import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useShortcutScope, type ShortcutHandlers } from "../../shortcuts";
import { MASK_EDIT_SCOPE, MASK_EDIT_SHORTCUTS } from "../../shortcuts/scopes/maskEdit";
import { FIT_VIEW, rotateTo, zoom100, zoomIn, zoomOut } from "../canvasView";
import type { MaskEditDispatch } from "./actions";
import type { DialogDrafts } from "./useDialogDrafts";
import type { PathEditing } from "./usePathEditing";
import type { CanvasNavigation } from "./useCanvasNavigation";
import type { ColorTools } from "./useColorTools";
import type { ToolSlotsController } from "./useToolSlots";
import type { BrushParamsController } from "./useBrushParams";
import type { ActiveSelection, SelectionDraft } from "./selection";
import { resolveSelectionCommand, type SelectionCommandId } from "./selectionCommands";

interface UseMaskEditorShortcutsArgs {
  workspace: "image" | "mask";
  dims: { w: number; h: number };
  dispatch: MaskEditDispatch;
  toolSlots: Pick<ToolSlotsController, "toolId" | "selectTool" | "selectSlot" | "cycleSlot">;
  brushParams: Pick<BrushParamsController, "shrinkBrush" | "growBrush" | "softenBrush" | "hardenBrush">;
  dialogs: DialogDrafts;
  pathEditing: Pick<
    PathEditing,
    "penAnchors" | "setPenAnchors" | "penPendingRef" | "editingPathRef" | "commitPathEdit" | "cancelPathEdit"
  >;
  navigation: Pick<CanvasNavigation, "setView" | "viewRef" | "viewBase" | "setSpacePan">;
  colors: Pick<ColorTools, "resetColors" | "swapColors">;
  activeSelectionRef: MutableRefObject<ActiveSelection | null>;
  setActiveSelection: Dispatch<SetStateAction<ActiveSelection | null>>;
  selectionDraft: SelectionDraft | null;
  setSelectionDraft: Dispatch<SetStateAction<SelectionDraft | null>>;
  setQuickMask: Dispatch<SetStateAction<boolean>>;
  setOverlayOnly: Dispatch<SetStateAction<boolean>>;
  setScreenMode: Dispatch<SetStateAction<0 | 1 | 2>>;
  closePenPath: () => void;
  requestClose: () => void;
}

export interface MaskEditorShortcutsController {
  openFreeTransform: () => void;
}

export function useMaskEditorShortcuts({
  workspace,
  dims,
  dispatch,
  toolSlots,
  brushParams,
  dialogs,
  pathEditing,
  navigation,
  colors,
  activeSelectionRef,
  setActiveSelection,
  selectionDraft,
  setSelectionDraft,
  setQuickMask,
  setOverlayOnly,
  setScreenMode,
  closePenPath,
  requestClose,
}: UseMaskEditorShortcutsArgs): MaskEditorShortcutsController {
  const openFreeTransform = () => {
    toolSlots.selectTool("move");
    dialogs.openFreeTransform();
  };

  const runSelectionCommand = (id: SelectionCommandId): boolean => {
    const resolution = resolveSelectionCommand(id, {
      workspace,
      activeSelection: activeSelectionRef.current,
      selectionDraft,
    });
    if (!resolution.handled) return false;
    if (resolution.selectToolId) toolSlots.selectTool(resolution.selectToolId);
    if (resolution.action) dispatch(resolution.action);
    if (resolution.clearActiveSelection) setActiveSelection(null);
    if (resolution.clearSelectionDraft) setSelectionDraft(null);
    return true;
  };

  const handlers: ShortcutHandlers = {
    tool_brush: () => toolSlots.selectSlot("brush"),
    tool_eraser: () => toolSlots.selectSlot("eraser"),
    tool_wand: () => toolSlots.selectSlot("selection"),
    tool_pen: () => toolSlots.selectSlot("pen"),
    tool_lasso: () => toolSlots.selectTool("magnetic_lasso"),
    tool_rect: () => toolSlots.selectSlot("marquee"),
    tool_ellipse: () => toolSlots.cycleSlot("marquee"),
    tool_gradient: () => toolSlots.selectSlot("fill"),
    tool_move: () => toolSlots.selectSlot("move"),
    tool_crop: () => toolSlots.selectSlot("crop"),
    free_transform: openFreeTransform,
    tool_path_select: () => toolSlots.selectSlot("path_select"),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    redo_alt: () => dispatch({ type: "redo" }),
    step_backward: () => dispatch({ type: "undo" }),
    clear: () => {
      runSelectionCommand("clear");
    },
    select_all: () => dispatch({ type: "op", op: { type: "select_all" } }),
    delete_selection: () => {
      runSelectionCommand("delete");
    },
    reselect: () => dispatch({ type: "reselect" }),
    duplicate: () => {
      runSelectionCommand("duplicate");
    },
    invert: () => {
      runSelectionCommand("invert");
    },
    brush_smaller: brushParams.shrinkBrush,
    brush_larger: brushParams.growBrush,
    brush_softer: brushParams.softenBrush,
    brush_harder: brushParams.hardenBrush,
    default_colors: colors.resetColors,
    quick_mask: () => setQuickMask((value) => !value),
    tool_healing: () => toolSlots.selectSlot("repair"),
    tool_clone: () => toolSlots.selectSlot("stamp"),
    tool_history_brush: () => toolSlots.selectSlot("history"),
    tool_dodge_burn: () => toolSlots.selectSlot("dodge"),
    tool_eyedropper: () => toolSlots.selectSlot("sample"),
    tool_shape: () => toolSlots.selectSlot("shape"),
    tool_hand: () => toolSlots.selectSlot("hand"),
    tool_rotate_view: () => toolSlots.selectSlot("rotate_view"),
    tool_zoom: () => toolSlots.selectSlot("zoom"),
    screen_mode: () => setScreenMode((mode) => ((mode + 1) % 3) as 0 | 1 | 2),
    pan_space: () => navigation.setSpacePan(true),
    zoom_in: () => navigation.setView((view) => zoomIn(view, ...navigation.viewBase())),
    zoom_out: () => navigation.setView((view) => zoomOut(view, ...navigation.viewBase())),
    zoom_fit: () => navigation.setView(FIT_VIEW),
    zoom_100: () => navigation.setView((view) => zoom100(view, dims.w, ...navigation.viewBase())),
    adjust_levels: () => dispatch({ type: "layer_add_adjustment", adjType: "levels" }),
    adjust_curve: () => dispatch({ type: "layer_add_adjustment", adjType: "curve" }),
    fill_dialog: dialogs.openFillDialog,
    image_size: dialogs.openImageSize,
    feather_dialog: () => {
      runSelectionCommand("feather");
    },
    swap_mode: colors.swapColors,
    close_path: () => {
      if (pathEditing.editingPathRef.current != null) {
        pathEditing.commitPathEdit();
        return;
      }
      if (!pathEditing.penPendingRef.current || pathEditing.penAnchors.length < 3) return false;
      closePenPath();
    },
    cancel: () => {
      if (pathEditing.editingPathRef.current != null) pathEditing.cancelPathEdit();
      else if (dialogs.cancelDialog()) return;
      else if (pathEditing.penPendingRef.current) pathEditing.setPenAnchors([]);
      else if (runSelectionCommand("cancel")) return;
      else if (toolSlots.toolId === "rotate_view" && navigation.viewRef.current.rotate) {
        navigation.setView((view) => rotateTo(view, 0));
      } else if (workspace !== "image") {
        requestClose();
      }
    },
    toggle_overlay: () => setOverlayOnly((value) => !value),
  };
  useShortcutScope(MASK_EDIT_SCOPE, MASK_EDIT_SHORTCUTS, handlers);

  return { openFreeTransform };
}
