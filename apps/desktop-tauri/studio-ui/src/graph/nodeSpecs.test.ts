import { describe, expect, it } from "vitest";
import { LOWERED_CARD_ROWS } from "./lowering";
import { NODE_SPECS, paletteGroups, type Executor, type NodeVisualFamily } from "./nodeSpecs";

const VALID: Executor[] = ["graph", "local", "compute", "api", "hybrid"];

const VALID_FAMILIES: NodeVisualFamily[] = [
  "image",
  "video",
  "audio",
  "psd",
  "mask",
  "crop",
  "grade",
  "api",
  "compute",
  "export",
  "utility",
];

describe("nodeSpecs executor tagging", () => {
  it("tags every node kind with a valid executor", () => {
    for (const [kind, spec] of Object.entries(NODE_SPECS)) {
      expect(VALID, `${kind} has a valid executor`).toContain(spec.executor);
    }
  });

  it("tags every node kind with a valid corner-badge visual family", () => {
    for (const [kind, spec] of Object.entries(NODE_SPECS)) {
      expect(VALID_FAMILIES, `${kind} has a valid family`).toContain(spec.family);
    }
  });

  it("keeps the badge family independent of the executor lane", () => {
    const expected: Record<string, NodeVisualFamily> = {
      imageSource: "image",
      videoSource: "video",
      psdTemplate: "psd",
      psdExport: "psd",
      subjectMask: "mask",
      refineMaskEdge: "mask",
      crop: "crop",
      imageGrade: "grade",
      matchLightColor: "grade",
      generate: "api",
      imageEnhance: "compute",
      save: "export",
    };
    for (const [kind, family] of Object.entries(expected)) {
      expect(NODE_SPECS[kind]?.family, kind).toBe(family);
    }
  });

  it("routes PSD bridge cards to local and provider cards to api", () => {
    const expected: Record<string, Executor> = {
      psdContextAnalyze: "local",
      matchLightColor: "local",
      refineMaskEdge: "local",
      imageEnhance: "local",
      detailWatchdog: "local",
      psdExport: "local",
      videoAssemble: "local",
      videoTrim: "local",
      subjectMask: "compute",
      generate: "api",
      detailRepaint: "api",
      promptOptimize: "hybrid",
      prompt: "graph",
    };
    for (const [kind, executor] of Object.entries(expected)) {
      expect(NODE_SPECS[kind]?.executor, kind).toBe(executor);
    }
  });

  it("groups the palette by production category, in flow order", () => {
    expect(paletteGroups().map((g) => g.category)).toEqual([
      "source",
      "generate",
      "process",
      "review",
      "workflow",
      "output",
    ]);

    const expected: Record<string, string> = {
      prompt: "source",
      imageSource: "source",
      videoSource: "source",
      psdTemplate: "source",
      generate: "generate",
      psdContextAnalyze: "process",
      subjectMask: "process",
      smartLayerSplit: "process",
      crop: "process",
      imageGrade: "process",
      refineMaskEdge: "process",
      imageEnhance: "process",
      detailRepaint: "process",
      matchLightColor: "process",
      preview: "review",
      detailWatchdog: "review",
      batch: "workflow",
      save: "output",
      psdExport: "output",
      videoAssemble: "output",
      videoTrim: "output",
    };
    for (const [kind, category] of Object.entries(expected)) {
      expect(NODE_SPECS[kind]?.category, kind).toBe(category);
    }
  });

  it("keeps implementation primitives out of the default palette", () => {
    const hidden = ["number", "compare", "logic", "if", "switch", "reroute"];
    const paletteKinds = new Set(paletteGroups().flatMap((group) => group.specs.map((spec) => spec.kind)));

    for (const kind of hidden) {
      expect(NODE_SPECS[kind], `${kind} still exists for saved workflows/runtime`).toBeTruthy();
      expect(NODE_SPECS[kind]?.palette, `${kind} is marked internal`).toBe("internal");
      expect(paletteKinds.has(kind), `${kind} is hidden from the default palette`).toBe(false);
    }
  });

  it("keeps leaf nodes absorbed by an integrated card out of the default palette", () => {
    const paletteKinds = new Set(paletteGroups().flatMap((group) => group.specs.map((spec) => spec.kind)));

    for (const [cardKind, rows] of Object.entries(LOWERED_CARD_ROWS)) {
      expect(paletteKinds.has(cardKind), `${cardKind} card is in the palette`).toBe(true);
      for (const row of rows) {
        expect(NODE_SPECS[row.kind], `${row.kind} still exists for saved workflows/lowering`).toBeTruthy();
        expect(NODE_SPECS[row.kind]?.palette, `${row.kind} is marked internal`).toBe("internal");
        expect(paletteKinds.has(row.kind), `${row.kind} is hidden from the default palette`).toBe(false);
      }
    }
  });
});
