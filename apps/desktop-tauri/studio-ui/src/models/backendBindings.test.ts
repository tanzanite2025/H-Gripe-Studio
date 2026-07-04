import { describe, expect, it } from "vitest";

import { validateBackendRefs } from "./backendBindings";
import {
  emptyRegistry,
  upsertApiProfile,
  upsertLocalModel,
  type ApiProfileEntry,
  type LocalModelEntry,
} from "./backendRegistry";
import { GRAPH_VERSION, type WorkflowGraph } from "../graph/model";

function apiProfile(overrides: Partial<ApiProfileEntry> = {}): ApiProfileEntry {
  return {
    ref: "openai-main",
    display_name: "OpenAI main",
    provider_kind: "openai-compatible",
    base_url: "https://api.example.com/v1",
    credentials_ref: "openai-key",
    default_model: "gpt-image-1",
    known_models: ["gpt-image-1"],
    capabilities: ["image.generate", "image.edit"],
    health: "untested",
    ...overrides,
  };
}

function localModel(overrides: Partial<LocalModelEntry> = {}): LocalModelEntry {
  return {
    ref: "sam2-base",
    display_name: "SAM2 base",
    capabilities: ["mask.subject"],
    engine: "onnx",
    weights_path: "C:/models/sam2.onnx",
    device_policy: "auto",
    precision_policy: "auto",
    health: "untested",
    fallback_policy: "built_in",
    health_detail: null,
    ...overrides,
  };
}

function graph(nodes: { id: string; kind: string; params: Record<string, unknown> }[]): WorkflowGraph {
  return {
    version: GRAPH_VERSION,
    nodes: nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })),
    edges: [],
  };
}

const registry = upsertLocalModel(upsertApiProfile(emptyRegistry(), apiProfile()), localModel());

describe("validateBackendRefs", () => {
  it("accepts empty refs and refs that exist with the right capability", () => {
    const g = graph([
      { id: "a", kind: "subjectMask", params: {} },
      { id: "b", kind: "subjectMask", params: { local_model_ref: "sam2-base" } },
      { id: "c", kind: "detailRepaint", params: { api_profile_ref: "openai-main" } },
    ]);
    expect(validateBackendRefs(g, registry)).toEqual([]);
  });

  it("flags refs missing from the manager", () => {
    const g = graph([{ id: "a", kind: "subjectMask", params: { local_model_ref: "gone" } }]);
    const issues = validateBackendRefs(g, registry);
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBe("a");
    expect(issues[0].message).toContain("not found");
  });

  it("flags refs whose entry lacks the selector's capability", () => {
    // sam2-base declares mask.subject only, but refineMaskEdge filters matte.refine.
    const g = graph([{ id: "a", kind: "refineMaskEdge", params: { local_model_ref: "sam2-base" } }]);
    const issues = validateBackendRefs(g, registry);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("matte.refine");
  });

  it("checks only the active row bindings on integrated cards", () => {
    // repair.engine defaults to "provider", so only the API binding is active:
    // the dangling local ref must not be flagged, the dangling API ref must be.
    const g = graph([
      {
        id: "card",
        kind: "imageProcessing",
        params: { "repair.api_profile_ref": "gone", "repair.local_model_ref": "also-gone" },
      },
    ]);
    const issues = validateBackendRefs(g, registry);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"gone"');
  });
});
