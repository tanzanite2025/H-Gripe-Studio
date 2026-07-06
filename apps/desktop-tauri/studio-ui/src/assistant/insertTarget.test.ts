import { describe, expect, it } from "vitest";

import {
  isAssistantInsertTarget,
  isPromptTextTarget,
  planGenerateInsert,
} from "./insertTarget";

describe("insert targets", () => {
  it("accepts prompt-text cards and Generate cards only", () => {
    expect(isPromptTextTarget("prompt")).toBe(true);
    expect(isPromptTextTarget("promptOptimize")).toBe(true);
    expect(isPromptTextTarget("generate")).toBe(false);
    expect(isAssistantInsertTarget("generate")).toBe(true);
    expect(isAssistantInsertTarget("imageSource")).toBe(false);
  });
});

describe("planGenerateInsert", () => {
  const kinds: Record<string, string> = {
    "prompt-1": "prompt",
    "opt-1": "promptOptimize",
    "psd-1": "psdContextAnalyze",
  };
  const kindOf = (id: string) => kinds[id] ?? null;

  it("updates the Prompt card already feeding the prompt input", () => {
    const edges = [
      { source: "prompt-1", target: "gen-1", targetHandle: "prompt" },
      { source: "opt-1", target: "gen-2", targetHandle: "prompt" },
    ];
    expect(planGenerateInsert("gen-1", edges, kindOf)).toEqual({
      action: "update_upstream",
      nodeId: "prompt-1",
    });
    expect(planGenerateInsert("gen-2", edges, kindOf)).toEqual({
      action: "update_upstream",
      nodeId: "opt-1",
    });
  });

  it("wires a new Prompt card when the prompt input is free", () => {
    const edges = [{ source: "prompt-1", target: "gen-1", targetHandle: "reference" }];
    expect(planGenerateInsert("gen-1", edges, kindOf)).toEqual({ action: "wire_new" });
  });

  it("refuses when a non-prompt node owns the prompt input", () => {
    const edges = [{ source: "psd-1", target: "gen-1", targetHandle: "prompt" }];
    expect(planGenerateInsert("gen-1", edges, kindOf)).toEqual({
      action: "blocked",
      nodeId: "psd-1",
    });
  });
});
