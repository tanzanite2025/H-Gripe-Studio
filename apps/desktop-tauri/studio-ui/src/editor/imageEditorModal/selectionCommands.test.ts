import { describe, expect, it } from "vitest";
import type { ActiveSelection, SelectionDraft } from "./selection";
import { resolveSelectionCommand } from "./selectionCommands";

const activeSelection: ActiveSelection = {
  region: [10, 20, 80, 90],
  ellipse: false,
  source: "rect_marquee",
  combineMode: "replace",
};

const selectionDraft: SelectionDraft = {
  region: [5, 6, 40, 44],
  ellipse: false,
  status: "closed",
  source: "pen",
  combineMode: "replace",
};

describe("resolveSelectionCommand", () => {
  it("clears visible drafts before active selections and falls back to clear document edits", () => {
    expect(resolveSelectionCommand("clear", {
      workspace: "image",
      activeSelection,
      selectionDraft,
    })).toEqual({ handled: true, clearSelectionDraft: true });

    expect(resolveSelectionCommand("clear", {
      workspace: "image",
      activeSelection: null,
      selectionDraft,
    })).toEqual({ handled: true, clearSelectionDraft: true });

    expect(resolveSelectionCommand("clear", {
      workspace: "image",
      activeSelection: null,
      selectionDraft: null,
    })).toEqual({ handled: true, action: { type: "clear" } });
  });

  it("cancels only selection state when a draft or active selection exists", () => {
    expect(resolveSelectionCommand("cancel", {
      workspace: "image",
      activeSelection: null,
      selectionDraft,
    })).toEqual({ handled: true, clearSelectionDraft: true });

    expect(resolveSelectionCommand("cancel", {
      workspace: "image",
      activeSelection,
      selectionDraft: null,
    })).toEqual({ handled: true, clearActiveSelection: true });

    expect(resolveSelectionCommand("cancel", {
      workspace: "image",
      activeSelection: null,
      selectionDraft: null,
    })).toEqual({ handled: false });
  });

  it("treats duplicate with active selection as Layer Via Copy and consumes marching ants", () => {
    expect(resolveSelectionCommand("duplicate", {
      workspace: "image",
      activeSelection,
      selectionDraft: null,
    })).toEqual({
      handled: true,
      action: {
        type: "layer_duplicate",
        selection: activeSelection,
        includeSourceImage: true,
      },
      clearActiveSelection: true,
    });
  });

  it("keeps ordinary duplicate, delete, and invert as command actions when no draft is visible", () => {
    expect(resolveSelectionCommand("duplicate", {
      workspace: "mask",
      activeSelection: null,
      selectionDraft: null,
    })).toEqual({
      handled: true,
      action: { type: "layer_duplicate" },
      clearActiveSelection: false,
    });

    expect(resolveSelectionCommand("delete", {
      workspace: "image",
      activeSelection,
      selectionDraft: null,
    })).toEqual({
      handled: true,
      action: { type: "op", op: { type: "delete" } },
    });

    expect(resolveSelectionCommand("invert", {
      workspace: "image",
      activeSelection,
      selectionDraft: null,
    })).toEqual({
      handled: true,
      action: { type: "op", op: { type: "invert" } },
    });
  });

  it("blocks pixel commands while a solid draft has not been committed", () => {
    for (const id of ["duplicate", "delete", "invert", "feather"] as const) {
      expect(resolveSelectionCommand(id, {
        workspace: "image",
        activeSelection,
        selectionDraft,
      })).toEqual({ handled: true });
    }
  });

  it("deselect clears only an active selection and never a draft", () => {
    expect(resolveSelectionCommand("deselect", {
      workspace: "image",
      activeSelection,
      selectionDraft: null,
    })).toEqual({ handled: true, clearActiveSelection: true });

    expect(resolveSelectionCommand("deselect", {
      workspace: "image",
      activeSelection: null,
      selectionDraft,
    })).toEqual({ handled: false });
  });

  it("feather routes to the feather tool flow without mutating selection state", () => {
    expect(resolveSelectionCommand("feather", {
      workspace: "mask",
      activeSelection,
      selectionDraft: null,
    })).toEqual({ handled: true, selectToolId: "feather" });
  });

  it("resolves Layer Via Copy identically for every selection source", () => {
    const sources = ["rect_marquee", "ellipse_marquee", "pen", "polygon_lasso", "magnetic_lasso", "mask"] as const;
    const resolutions = sources.map((source) =>
      resolveSelectionCommand("duplicate", {
        workspace: "image",
        activeSelection: { ...activeSelection, source },
        selectionDraft: null,
      }),
    );
    for (const [index, resolution] of resolutions.entries()) {
      expect(resolution).toEqual({
        handled: true,
        action: {
          type: "layer_duplicate",
          selection: { ...activeSelection, source: sources[index] },
          includeSourceImage: true,
        },
        clearActiveSelection: true,
      });
    }
  });

  it("never lets Layer Via Copy consume an uncommitted draft or duplicate instead", () => {
    expect(resolveSelectionCommand("duplicate", {
      workspace: "image",
      activeSelection: null,
      selectionDraft,
    })).toEqual({
      handled: true,
    });
  });
});
