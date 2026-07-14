// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dispatchShortcut } from "../../shortcuts";
import { useImageEditorShortcuts } from "./useImageEditorShortcuts";
import type { ActiveSelection, SelectionDraft } from "./selection";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { bubbles: true, ...init });

describe("useImageEditorShortcuts", () => {
  function baseArgs(
    overrides: Partial<Parameters<typeof useImageEditorShortcuts>[0]> = {},
  ): Parameters<typeof useImageEditorShortcuts>[0] {
    return {
      workspace: "image" as const,
      dims: { w: 100, h: 100 },
      dispatch: vi.fn(),
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
      activeSelectionRef: { current: null },
      setActiveSelection: vi.fn(),
      selectionDraft: null,
      setSelectionDraft: vi.fn(),
      setQuickMask: vi.fn(),
      setOverlayOnly: vi.fn(),
      setScreenMode: vi.fn(),
      closePenPath: vi.fn(),
      requestClose: vi.fn(),
      runCommand: vi.fn(),
      ...overrides,
    };
  }

  it("routes Ctrl+J through the shared layer command controller", () => {
    const selection: ActiveSelection = {
      region: [10, 20, 80, 90],
      ellipse: false,
      source: "rect_marquee",
      combineMode: "replace",
    };
    const setActiveSelection = vi.fn();
    const runCommand = vi.fn();

    const hook = renderHook(() =>
      useImageEditorShortcuts(baseArgs({
        activeSelectionRef: { current: selection },
        setActiveSelection,
        runCommand,
      })),
    );

    expect(dispatchShortcut(key({ key: "j", ctrlKey: true }))).toBe(true);

    expect(runCommand).toHaveBeenCalledWith("layer.duplicate");
    expect(setActiveSelection).not.toHaveBeenCalled();

    hook.unmount();
  });

  it("leaves draft blocking to the shared layer command controller", () => {
    const selection: ActiveSelection = {
      region: [10, 20, 80, 90],
      ellipse: false,
      source: "rect_marquee",
      combineMode: "replace",
    };
    const draft: SelectionDraft = {
      region: [5, 6, 40, 44],
      ellipse: false,
      status: "closed",
      source: "rect_marquee",
      combineMode: "replace",
    };
    const setActiveSelection = vi.fn();
    const runCommand = vi.fn();

    const hook = renderHook(() =>
      useImageEditorShortcuts(baseArgs({
        activeSelectionRef: { current: selection },
        setActiveSelection,
        selectionDraft: draft,
        runCommand,
      })),
    );

    expect(dispatchShortcut(key({ key: "j", ctrlKey: true }))).toBe(true);

    expect(runCommand).toHaveBeenCalledWith("layer.duplicate");
    expect(setActiveSelection).not.toHaveBeenCalled();

    hook.unmount();
  });
});
