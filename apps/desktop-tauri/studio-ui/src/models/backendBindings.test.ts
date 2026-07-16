import { describe, expect, it } from "vitest";

import { validateBackendRefs } from "./backendBindings";
import {
  emptyRegistry,
  upsertApiProfile,
  type ApiProfileEntry,
  type BackendRegistry,
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

function graph(
  nodes: { id: string; kind: string; params: Record<string, unknown> }[],
  edges: WorkflowGraph["edges"] = [],
): WorkflowGraph {
  return {
    version: GRAPH_VERSION,
    nodes: nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } })),
    edges,
  };
}

const registry: BackendRegistry = upsertApiProfile(emptyRegistry(), apiProfile());

describe("validateBackendRefs", () => {
  it("accepts empty refs and compatible API profiles", () => {
    const workflow = graph([
      { id: "a", kind: "subjectMask", params: {} },
      { id: "b", kind: "detailRepaint", params: { api_profile_ref: "openai-main" } },
    ]);
    expect(validateBackendRefs(workflow, registry)).toEqual([]);
  });

  it("warns for missing or capability-incompatible API refs", () => {
    const missing = validateBackendRefs(
      graph([{ id: "a", kind: "detailRepaint", params: { api_profile_ref: "gone" } }]),
      registry,
    );
    expect(missing).toMatchObject([{ nodeId: "a", blocking: false }]);
    expect(missing[0].message).toContain("not found");

    const incompatibleRegistry = upsertApiProfile(
      emptyRegistry(),
      apiProfile({ capabilities: ["image.generate"] }),
    );
    const incompatible = validateBackendRefs(
      graph([{ id: "a", kind: "detailRepaint", params: { api_profile_ref: "openai-main" } }]),
      incompatibleRegistry,
    );
    expect(incompatible[0].message).toContain("does not declare capability image.edit");
  });

  it("blocks every persisted local-model ref explicitly", () => {
    const issues = validateBackendRefs(
      graph([{ id: "mask", kind: "subjectMask", params: { local_model_ref: "legacy-mask" } }]),
      registry,
    );
    expect(issues).toMatchObject([{ nodeId: "mask", blocking: true }]);
    expect(issues[0].message).toContain("retired and unavailable");
  });

  it("blocks retired inference engines even without a model ref", () => {
    const issues = validateBackendRefs(
      graph([{ id: "enhance", kind: "imageEnhance", params: { engine: "realesrgan" } }]),
      registry,
    );
    expect(issues).toMatchObject([{ nodeId: "enhance", blocking: true }]);
  });

  it("validates only wired rows of integrated cards", () => {
    const workflow = graph(
      [
        { id: "src", kind: "imageSource", params: {} },
        {
          id: "card",
          kind: "imageProcessing",
          params: {
            "enhance.local_model_ref": "retired",
            "repair.api_profile_ref": "openai-main",
          },
        },
      ],
      [
        {
          id: "e1",
          source: "src",
          sourcePort: "image",
          target: "card",
          targetPort: "repair.in",
        },
      ],
    );
    expect(validateBackendRefs(workflow, registry)).toEqual([]);
  });
});
