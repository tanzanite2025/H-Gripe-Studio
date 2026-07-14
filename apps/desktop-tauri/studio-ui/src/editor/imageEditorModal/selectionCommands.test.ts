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
      activeSelection,
      selectionDraft,
    })).toEqual({ handled: true, clearSelectionDraft: true });

    expect(resolveSelectionCommand("clear", {
      activeSelection: null,
      selectionDraft,
    })).toEqual({ handled: true, clearSelectionDraft: true });

    expect(resolveSelectionCommand("clear", {
      activeSelection: null,
      selectionDraft: null,
    })).toEqual({ handled: true, action: { type: "clear" } });
  });

  it("cancels only selection state when a draft or active selection exists", () => {
    expect(resolveSelectionCommand("cancel", {
      activeSelection: null,
      selectionDraft,
    })).toEqual({ handled: true, clearSelectionDraft: true });

    expect(resolveSelectionCommand("cancel", {
      activeSelection,
      selectionDraft: null,
    })).toEqual({ handled: true, clearActiveSelection: true });

    expect(resolveSelectionCommand("cancel", {
      activeSelection: null,
      selectionDraft: null,
    })).toEqual({ handled: false });
  });

  it("keeps delete and invert as command actions when no draft is visible", () => {
    expect(resolveSelectionCommand("delete", {
      activeSelection,
      selectionDraft: null,
    })).toEqual({
      handled: true,
      action: { type: "op", op: { type: "delete" } },
    });

    expect(resolveSelectionCommand("invert", {
      activeSelection,
      selectionDraft: null,
    })).toEqual({
      handled: true,
      action: { type: "op", op: { type: "invert" } },
    });
  });

  it("blocks pixel commands while a solid draft has not been committed", () => {
    for (const id of ["delete", "invert", "feather"] as const) {
      expect(resolveSelectionCommand(id, {
        activeSelection,
        selectionDraft,
      })).toEqual({ handled: true });
    }
  });

  it("deselect clears only an active selection and never a draft", () => {
    expect(resolveSelectionCommand("deselect", {
      activeSelection,
      selectionDraft: null,
    })).toEqual({ handled: true, clearActiveSelection: true });

    expect(resolveSelectionCommand("deselect", {
      activeSelection: null,
      selectionDraft,
    })).toEqual({ handled: false });
  });

  it("feather routes to the feather tool flow without mutating selection state", () => {
    expect(resolveSelectionCommand("feather", {
      activeSelection,
      selectionDraft: null,
    })).toEqual({ handled: true, selectToolId: "feather" });
  });

});
