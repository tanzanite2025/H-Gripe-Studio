// Node type registry. Specifications are grouped by product domain under nodeSpecs/.

import { SOURCE_NODE_SPECS } from "./nodeSpecs/source";
import { GENERATION_NODE_SPECS } from "./nodeSpecs/generation";
import { IMAGE_NODE_SPECS } from "./nodeSpecs/image";
import { PSD_NODE_SPECS } from "./nodeSpecs/psd";
import { QUALITY_NODE_SPECS } from "./nodeSpecs/quality";
import { VIDEO_NODE_SPECS } from "./nodeSpecs/video";
import { WORKFLOW_NODE_SPECS } from "./nodeSpecs/workflow";
import { OUTPUT_NODE_SPECS } from "./nodeSpecs/output";
import { INTERNAL_NODE_SPECS } from "./nodeSpecs/internal";
import type { NodeSpec } from "./nodeSpecs/types";

export * from "./nodeSpecs/types";

function combineNodeSpecGroups(...groups: Record<string, NodeSpec>[]): Record<string, NodeSpec> {
  const catalog: Record<string, NodeSpec> = {};
  for (const group of groups) {
    for (const [kind, spec] of Object.entries(group)) {
      if (kind in catalog) throw new Error(`duplicate node spec: ${kind}`);
      catalog[kind] = spec;
    }
  }
  return catalog;
}

const NODE_SPEC_CATALOG = combineNodeSpecGroups(
  SOURCE_NODE_SPECS,
  GENERATION_NODE_SPECS,
  IMAGE_NODE_SPECS,
  PSD_NODE_SPECS,
  QUALITY_NODE_SPECS,
  VIDEO_NODE_SPECS,
  WORKFLOW_NODE_SPECS,
  OUTPUT_NODE_SPECS,
  INTERNAL_NODE_SPECS,
);

export const NODE_SPECS: Record<string, NodeSpec> = {
  promptOptimize: NODE_SPEC_CATALOG.promptOptimize,
  batch: NODE_SPEC_CATALOG.batch,
  imageSource: NODE_SPEC_CATALOG.imageSource,
  videoSource: NODE_SPEC_CATALOG.videoSource,
  psdTemplate: NODE_SPEC_CATALOG.psdTemplate,
  number: NODE_SPEC_CATALOG.number,
  generate: NODE_SPEC_CATALOG.generate,
  compare: NODE_SPEC_CATALOG.compare,
  logic: NODE_SPEC_CATALOG.logic,
  if: NODE_SPEC_CATALOG.if,
  switch: NODE_SPEC_CATALOG.switch,
  reroute: NODE_SPEC_CATALOG.reroute,
  save: NODE_SPEC_CATALOG.save,
  psdContextAnalyze: NODE_SPEC_CATALOG.psdContextAnalyze,
  matchLightColor: NODE_SPEC_CATALOG.matchLightColor,
  imageProcessing: NODE_SPEC_CATALOG.imageProcessing,
  videoProcessing: NODE_SPEC_CATALOG.videoProcessing,
  subjectMask: NODE_SPEC_CATALOG.subjectMask,
  smartLayerSplit: NODE_SPEC_CATALOG.smartLayerSplit,
  crop: NODE_SPEC_CATALOG.crop,
  imageGrade: NODE_SPEC_CATALOG.imageGrade,
  refineMaskEdge: NODE_SPEC_CATALOG.refineMaskEdge,
  imageEnhance: NODE_SPEC_CATALOG.imageEnhance,
  detailWatchdog: NODE_SPEC_CATALOG.detailWatchdog,
  detailRepaint: NODE_SPEC_CATALOG.detailRepaint,
  videoAssemble: NODE_SPEC_CATALOG.videoAssemble,
  videoTrim: NODE_SPEC_CATALOG.videoTrim,
  psdExport: NODE_SPEC_CATALOG.psdExport,
};

export function nodeSpec(kind: string): NodeSpec {
  const spec = NODE_SPECS[kind];
  if (!spec) throw new Error(`unknown node kind: ${kind}`);
  return spec;
}

export function defaultParams(kind: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of nodeSpec(kind).params) out[p.key] = p.defaultValue ?? "";
  return out;
}

/**
 * Node kinds grouped by palette category, in display order. The order mirrors
 * a production flow (source -> generate -> process -> review -> output);
 * `internal` primitives are never listed.
 */
export type PaletteCategory = Exclude<NodeSpec["category"], "internal">;

export function paletteGroups(): { category: PaletteCategory; specs: NodeSpec[] }[] {
  const order: PaletteCategory[] = ["source", "generate", "process", "review", "workflow", "output"];
  return order.map((category) => ({
    category,
    specs: Object.values(NODE_SPECS).filter((s) => s.category === category && s.palette !== "internal"),
  }));
}
