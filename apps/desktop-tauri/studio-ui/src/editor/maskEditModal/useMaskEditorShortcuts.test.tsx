// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dispatchShortcut } from "../../shortcuts";
import { useMaskEditorShortcuts } from "./useMaskEditorShortcuts";
import type { ActiveSelection } from "./selection";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, ...init });

describe("useMaskEditorShortcuts", () => {
  it("clears the active marching-ants selection after Ctrl+J layer via copy", () => {
    const selection: ActiveSelection = {
      region: [10, 20, 80, 90],
      ellipse: false,
      source: "rect_marquee",
      combineMode: "replace",
    };
    const dispatch = vi.fn();
    const setActiveSelection = vi.fn();

    const hook = renderHook(() =>
      useMaskEditorShortcuts({
        workspace: "image",
        dims: { w: 100, h: 100 },
        dispatch,
        toolSlots: {
          toolId: "move",
          selectTool: vi.fn(),
          selectSlot: vi.fn(),
          cycleSlot: vi.fn(),
        },
        brushParams: {
          shrinkBrush: vi.fn(),
          growBrush: vi.fn(),
          softenBrush: vi.fn(),
          hardenBrush: vi.fn(),
        },
        dialogs: {
          openFreeTransform: vi.fn(),
          openFillDialog: vi.fn(),
          openImageSize: vi.fn(),
          cancelDialog: vi.fn(() => false),
        } as any,
        pathEditing: {
          penAnchors: [],
          setPenAnchors: vi.fn(),
          penPendingRef: { current: false },
          editingPathRef: { current: null },
          commitPathEdit: vi.fn(),
          cancelPathEdit: vi.fn(),
        },
        navigation: {
          setView: vi.fn(),
          viewRef: { current: { zoom: 1, panX: 0, panY: 0, rotate: 0 } },
          viewBase: () => [100, 100],
          setSpacePan: vi.fn(),
        },
        colors: {
          resetColors: vi.fn(),
          swapColors: vi.fn(),
        },
        activeSelectionRef: { current: selection },
        setActiveSelection,
        selectionDraft: null,
        setSelectionDraft: vi.fn(),
        setQuickMask: vi.fn(),
        setOverlayOnly: vi.fn(),
        setScreenMode: vi.fn(),
        closePenPath: vi.fn(),
        requestClose: vi.fn(),
      }),
    );

    expect(dispatchShortcut(key({ key: "j", ctrlKey: true }))).toBe(true);

    expect(dispatch).toHaveBeenCalledWith({
      type: "layer_duplicate",
      selection,
      includeSourceImage: true,
    });
    expect(setActiveSelection).toHaveBeenCalledWith(null);

    hook.unmount();
  });
});
