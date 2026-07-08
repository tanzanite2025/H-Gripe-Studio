// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowGraph } from "../graph/model";
import { DEFAULT_CANVAS_VIEWPORT } from "./canvasDocument";
import type { ImageDocument } from "./imageDocument";
import {
  clearLocalProjectManifest,
  loadLocalProjectManifest,
  parseProjectManifest,
  saveLocalProjectManifest,
  serializeProjectManifest,
  type ProjectManifest,
} from "./projectManifest";

function graph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: "n1", kind: "prompt", position: { x: 0, y: 0 }, params: { text: "hi" } },
    ],
    edges: [],
  };
}

function manifest(): ProjectManifest {
  return {
    version: 1,
    activeCanvasId: "c2",
    canvases: [
      {
        id: "c1",
        path: "C:/flows/a.json",
        dirty: false,
        name: null,
        selectedNodeId: null,
        viewport: { x: 10, y: -5, zoom: 1.5 },
        graph: graph(),
        mediaEditDrafts: {},
      },
      {
        id: "c2",
        path: null,
        dirty: true,
        name: "draft",
        selectedNodeId: "n1",
        viewport: DEFAULT_CANVAS_VIEWPORT,
        graph: graph(),
        mediaEditDrafts: {},
      },
    ],
  };
}

function imageDraft(): ImageDocument {
  return {
    version: 1,
    layers: [
      {
        id: "l1",
        name: "Background",
        layer: { kind: "pixel", edits: [{ type: "crop", region: [0, 0, 10, 10] }] },
        blend: "normal",
        opacity: 1,
        visible: true,
      },
    ],
    active: 0,
    matte_strokes: [],
    points: [],
    layerGroups: [],
  };
}

afterEach(() => clearLocalProjectManifest());

describe("project manifest", () => {
  it("round-trips through serialize + parse", () => {
    const parsed = parseProjectManifest(serializeProjectManifest(manifest()));
    expect(parsed).toEqual(manifest());
  });

  it("round-trips through localStorage", () => {
    saveLocalProjectManifest(manifest());
    expect(loadLocalProjectManifest()).toEqual(manifest());
  });

  it("round-trips image editor drafts in the manifest", () => {
    const m = manifest();
    m.canvases[1].mediaEditDrafts = { n1: imageDraft() };
    const parsed = parseProjectManifest(serializeProjectManifest(m));
    expect(parsed?.canvases[1].mediaEditDrafts.n1).toEqual(imageDraft());
  });

  it("returns null for absent, corrupt, or wrong-version payloads", () => {
    expect(parseProjectManifest(null)).toBeNull();
    expect(parseProjectManifest("")).toBeNull();
    expect(parseProjectManifest("not json")).toBeNull();
    expect(parseProjectManifest(JSON.stringify({ version: 2 }))).toBeNull();
    expect(parseProjectManifest(JSON.stringify({ version: 1, canvases: [] }))).toBeNull();
  });

  it("drops malformed canvases and falls back to the first for the active id", () => {
    const m = manifest();
    const raw = JSON.stringify({
      version: 1,
      activeCanvasId: "missing",
      canvases: [{ id: "", graph: graph() }, m.canvases[0], { id: "bad" }],
    });
    const parsed = parseProjectManifest(raw);
    expect(parsed?.canvases.map((c) => c.id)).toEqual(["c1"]);
    expect(parsed?.activeCanvasId).toBe("c1");
  });

  it("defaults missing viewport/selection/dirty fields per canvas", () => {
    const raw = JSON.stringify({
      version: 1,
      activeCanvasId: "c1",
      canvases: [{ id: "c1", graph: graph() }],
    });
    const parsed = parseProjectManifest(raw);
    expect(parsed?.canvases[0]).toMatchObject({
      path: null,
      dirty: false,
      name: null,
      selectedNodeId: null,
      viewport: DEFAULT_CANVAS_VIEWPORT,
      mediaEditDrafts: {},
    });
  });
});
