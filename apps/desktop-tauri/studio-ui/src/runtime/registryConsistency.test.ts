import { describe, expect, it } from "vitest";

import { NODE_SPECS } from "../graph/nodeSpecs";
import { defaultExecutors } from "./executors";

describe("node spec and browser executor registries", () => {
  it("registers executors only for known node kinds", () => {
    for (const kind of Object.keys(defaultExecutors)) {
      if (kind === "group") continue;
      expect(NODE_SPECS[kind], `${kind} executor has a node spec`).toBeTruthy();
    }
  });

  it("covers every graph, API, and hybrid node in the browser registry", () => {
    for (const [kind, spec] of Object.entries(NODE_SPECS)) {
      if (!["graph", "api", "hybrid"].includes(spec.executor)) continue;
      expect(defaultExecutors[kind], `${kind} has a browser executor`).toBeTypeOf("function");
    }
  });

  it("keeps each registry key aligned with its spec kind", () => {
    for (const [kind, spec] of Object.entries(NODE_SPECS)) {
      expect(spec.kind).toBe(kind);
    }
  });
});
