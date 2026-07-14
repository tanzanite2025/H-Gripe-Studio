// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createNativeFileDropRouter } from "./nativeFileDropRouter";

function environment(target: Element | null, dpr = 2) {
  return {
    devicePixelRatio: () => dpr,
    elementFromPoint: vi.fn(() => target),
  };
}

const event = {
  paths: ["C:/images/a.png"],
  position: { x: 200, y: 120 },
};

describe("native file drop router", () => {
  it("delivers a drop only to the highest-priority claiming consumer", () => {
    const target = document.createElement("div");
    const env = environment(target);
    const router = createNativeFileDropRouter(env);
    const graph = vi.fn();
    const editor = vi.fn();
    router.register({ id: "graph", priority: 10, claims: () => true, handle: graph });
    router.register({ id: "editor", priority: 100, claims: () => true, handle: editor });

    expect(router.route(event)).toBe(true);

    expect(editor).toHaveBeenCalledOnce();
    expect(graph).not.toHaveBeenCalled();
    expect(env.elementFromPoint).toHaveBeenCalledWith(100, 60);
    expect(editor.mock.calls[0][0]).toMatchObject({ target, cssPosition: { x: 100, y: 60 } });
  });

  it("lets a claiming modal consume chrome drops without falling through", () => {
    const target = document.createElement("button");
    const router = createNativeFileDropRouter(environment(target));
    const graph = vi.fn();
    const editor = vi.fn();
    router.register({ id: "graph", priority: 10, claims: () => true, handle: graph });
    router.register({
      id: "editor",
      priority: 100,
      claims: ({ target: hit }) => hit === target,
      handle: editor,
    });

    router.route(event);

    expect(editor).toHaveBeenCalledOnce();
    expect(graph).not.toHaveBeenCalled();
  });

  it("unregisters an exact consumer and reports unclaimed drops", () => {
    const router = createNativeFileDropRouter(environment(null, 1));
    const handle = vi.fn();
    const unregister = router.register({ id: "graph", priority: 10, claims: () => true, handle });
    unregister();

    expect(router.route(event)).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it("shares a pending listener across StrictMode setup-cleanup-setup", async () => {
    let resolveListener!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    const listen = vi.fn(() => new Promise<() => void>((resolve) => {
      resolveListener = resolve;
    }));
    const router = createNativeFileDropRouter(environment(null));

    const firstRelease = router.retainListener(listen);
    firstRelease();
    const secondRelease = router.retainListener(listen);
    expect(listen).toHaveBeenCalledOnce();

    resolveListener(unlisten);
    await Promise.resolve();
    expect(unlisten).not.toHaveBeenCalled();
    secondRelease();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("contains async consumer failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const router = createNativeFileDropRouter(environment(null));
    router.register({
      id: "broken",
      priority: 1,
      claims: () => true,
      handle: async () => { throw new Error("failed"); },
    });

    expect(router.route(event)).toBe(true);
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      "Native file drop consumer broken failed",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
