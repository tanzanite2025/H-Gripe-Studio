import { describe, expect, it } from "vitest";

import { NODE_SPECS } from "./nodeSpecs";
import { NODE_ZH, localizeSpec } from "./nodeSpecsI18n";
import { IMAGE_EDITOR_TOOLS } from "../editor/imageEditorTools";
import { IMAGE_EDITOR_TOOL_ZH } from "../editor/imageEditorToolsI18n";

// Long-term guard: every human-readable string in the node catalogue (and the
// Image Editor tool registry) must have a Simplified-Chinese translation. A new
// node, param, port, or tool that ships English-only fails CI here rather than
// silently leaking English when the UI is switched to 中文.

describe("nodeSpecs zh coverage", () => {
  for (const [kind, spec] of Object.entries(NODE_SPECS)) {
    describe(kind, () => {
      const tr = NODE_ZH[kind];

      it("has a translation entry", () => {
        expect(tr, `NODE_ZH["${kind}"] missing`).toBeTruthy();
      });

      it("translates title and description", () => {
        expect(tr?.title, `${kind}.title`).toBeTruthy();
        expect(tr?.description, `${kind}.description`).toBeTruthy();
      });

      it("translates every param label and hint", () => {
        for (const p of spec.params) {
          expect(tr?.params?.[p.key]?.label, `${kind}.params.${p.key}.label`).toBeTruthy();
          if (p.hint) {
            expect(tr?.params?.[p.key]?.hint, `${kind}.params.${p.key}.hint`).toBeTruthy();
          }
        }
      });

      it("translates every port label", () => {
        for (const port of [...spec.inputs, ...spec.outputs]) {
          expect(tr?.ports?.[port.id], `${kind}.ports.${port.id}`).toBeTruthy();
        }
      });
    });
  }

  it("has no stale NODE_ZH entries for removed nodes", () => {
    for (const kind of Object.keys(NODE_ZH)) {
      expect(NODE_SPECS[kind], `NODE_ZH["${kind}"] has no matching NODE_SPECS entry`).toBeTruthy();
    }
  });

  it("localizeSpec returns the English spec for en and applies zh strings for zh", () => {
    const en = localizeSpec(NODE_SPECS.promptOptimize, "en");
    expect(en.title).toBe(NODE_SPECS.promptOptimize.title);
    const zh = localizeSpec(NODE_SPECS.promptOptimize, "zh");
    expect(zh.title).toBe(NODE_ZH.promptOptimize.title);
    // Structure is preserved (same number of params/ports).
    expect(zh.params.length).toBe(NODE_SPECS.promptOptimize.params.length);
    expect(zh.outputs.length).toBe(NODE_SPECS.promptOptimize.outputs.length);
  });
});

describe("mask tool zh coverage", () => {
  for (const tool of IMAGE_EDITOR_TOOLS) {
    it(`translates the "${tool.id}" tool`, () => {
      expect(IMAGE_EDITOR_TOOL_ZH[tool.id]?.label, `${tool.id}.label`).toBeTruthy();
      expect(IMAGE_EDITOR_TOOL_ZH[tool.id]?.hint, `${tool.id}.hint`).toBeTruthy();
    });
  }

  it("has no stale IMAGE_EDITOR_TOOL_ZH entries", () => {
    const ids = new Set(IMAGE_EDITOR_TOOLS.map((t) => t.id));
    for (const id of Object.keys(IMAGE_EDITOR_TOOL_ZH)) {
      expect(ids.has(id), `IMAGE_EDITOR_TOOL_ZH["${id}"] has no matching tool`).toBe(true);
    }
  });
});
