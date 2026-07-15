import { describe, expect, it } from "vitest";
import {
  IMAGE_ENHANCE_DEVICE_OPTIONS,
  IMAGE_ENHANCE_ENGINE_OPTIONS,
  IMAGE_ENHANCE_PRECISION_OPTIONS,
} from "../contracts/imageEnhance";
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
    };
    for (const [kind, executor] of Object.entries(expected)) {
      expect(NODE_SPECS[kind]?.executor, kind).toBe(executor);
    }
  });

  it("keeps Match Light & Color engine and device choices aligned with the native contract", () => {
    const params = NODE_SPECS.matchLightColor.params;
    const engine = params.find((param) => param.key === "engine");
    const device = params.find((param) => param.key === "device");
    expect(params.find((param) => param.key === "local_model_ref")).toBeUndefined();

    expect(engine).toMatchObject({
      control: "select",
      options: ["cpu", "onnx_harmonize"],
      defaultValue: "cpu",
      visibleWhen: { param: "mode", in: ["color_transfer", "histogram_match", "hybrid"] },
    });
    expect(device).toMatchObject({
      control: "select",
      options: ["auto", "gpu", "cpu"],
      defaultValue: "auto",
      visibleWhen: { param: "engine", in: ["onnx_harmonize"] },
    });
  });

  it("uses the vendor-neutral ONNX device choices on every visible native card", () => {
    for (const kind of [
      "subjectMask",
      "matchLightColor",
      "refineMaskEdge",
      "detailWatchdog",
    ] as const) {
      const device = NODE_SPECS[kind].params.find((param) => param.key === "device");
      expect(device, kind).toMatchObject({
        control: "select",
        options: ["auto", "gpu", "cpu"],
        defaultValue: "auto",
      });
    }
  });

  it("keeps both Image Enhance specs aligned with the native Real-ESRGAN contract", () => {
    const cases = [
      {
        kind: "imageProcessing",
        engineKey: "enhance.engine",
        deviceKey: "enhance.device",
        precisionKey: "enhance.precision",
      },
      {
        kind: "imageEnhance",
        engineKey: "engine",
        deviceKey: "device",
        precisionKey: "precision",
      },
    ] as const;

    for (const { kind, engineKey, deviceKey, precisionKey } of cases) {
      const params = NODE_SPECS[kind].params;
      const engine = params.find((param) => param.key === engineKey);
      const device = params.find((param) => param.key === deviceKey);
      const precision = params.find((param) => param.key === precisionKey);

      expect(engine, `${kind} engine`).toMatchObject({
        control: "select",
        options: [...IMAGE_ENHANCE_ENGINE_OPTIONS],
        defaultValue: "cpu",
      });
      expect(device, `${kind} device`).toMatchObject({
        control: "select",
        options: [...IMAGE_ENHANCE_DEVICE_OPTIONS],
        defaultValue: "auto",
        visibleWhen: { param: engineKey, in: ["realesrgan"] },
      });
      expect(precision, `${kind} precision`).toMatchObject({
        control: "select",
        options: [...IMAGE_ENHANCE_PRECISION_OPTIONS],
        defaultValue: "auto",
        visibleWhen: { param: engineKey, in: ["realesrgan"] },
      });
      expect(`${engine?.hint} ${device?.hint} ${precision?.hint}`).not.toMatch(/ccsr|supir/i);
    }

    for (const key of ["enhance.engine", "enhance.device", "enhance.precision"]) {
      expect(
        NODE_SPECS.imageProcessing.params.find((param) => param.key === key),
        `${key} must be operable on the product-facing card`,
      ).toMatchObject({ inline: true, port: "enhance.in" });
    }
  });

  it("groups the palette by production category, in flow order", () => {
    expect(paletteGroups().map((g) => g.category)).toEqual([
      "source",
      "generate",
      "process",
      "review",
      "output",
    ]);

    const expected: Record<string, string> = {
      promptOptimize: "source",
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
      detailWatchdog: "review",
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
