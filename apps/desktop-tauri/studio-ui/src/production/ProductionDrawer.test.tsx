// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { MediaAsset } from "./mediaBin";
import { ProductionDrawer, type ProductionDrawerPorts } from "./ProductionDrawer";
import { defaultClipProperties, type ClipProperties } from "./clipProps";
import {
  createProductionStore,
  type ProductionState,
  type ProductionStore,
} from "./productionStore";
import { ProductionStoreProvider } from "./productionStoreContext";
import type { TimelineModel } from "./timeline";

// The program monitor needs a real viewport host (ResizeObserver, frame
// presentation); keep a marker so drawer layout tests can assert it is mounted.
vi.mock("./ProgramMonitor", () => ({ ProgramMonitor: () => <div data-testid="program-monitor" /> }));

const assets: MediaAsset[] = [
  { id: "asset-v", kind: "video", path: "/media/a.mp4", name: "a.mp4", addedAt: 0 },
  { id: "asset-i", kind: "image", path: "/media/b.png", name: "b.png", addedAt: 0 },
  { id: "asset-a", kind: "audio", path: "/media/c.wav", name: "c.wav", addedAt: 0 },
];

const timeline: TimelineModel = {
  id: "timeline-1",
  fps: 24,
  tracks: [
    {
      id: "track-v1",
      kind: "video",
      clips: [
        { id: "clip-video", kind: "video", assetId: "asset-v", start: 0, duration: 10, sourceStartSec: 0 },
        { id: "clip-still", kind: "still", assetId: "asset-i", start: 10, duration: 5, sourceStartSec: 0 },
      ],
    },
    {
      id: "track-a1",
      kind: "audio",
      clips: [{ id: "clip-audio", kind: "audio", assetId: "asset-a", start: 0, duration: 8, sourceStartSec: 0 }],
    },
  ],
};

beforeAll(() => {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });
});

function seededStore(overrides: Partial<ProductionState> = {}): ProductionStore {
  const store = createProductionStore();
  store.mutate((state) => ({
    ...state,
    binAssets: assets,
    timeline,
    ...overrides,
  }));
  return store;
}

function drawerPorts(overrides: Partial<ProductionDrawerPorts> = {}): ProductionDrawerPorts {
  return {
    assetBin: { addableAsset: null, addSelected: () => {} },
    editorLauncher: {
      openImageEdit: () => {},
      openAudioEdit: () => {},
      openClipGrade: () => {},
      splitClipToLayers: () => {},
    },
    exportService: { open: () => {} },
    layerService: {
      asset: null,
      selectedLayerId: null,
      selectLayer: () => {},
      visibility: {},
      toggleVisibility: () => {},
    },
    ...overrides,
  };
}

function renderDrawer(store: ProductionStore, ports: ProductionDrawerPorts = drawerPorts()) {
  return render(
    <ProductionStoreProvider store={store}>
      <ProductionDrawer mode="open" onSetMode={() => {}} target={null} ports={ports} />
    </ProductionStoreProvider>,
  );
}

function openClipMenu(container: HTMLElement, clipName: string): void {
  const clip = Array.from(container.querySelectorAll<HTMLElement>(".production-clip")).find(
    (el) => el.textContent?.includes(clipName),
  );
  expect(clip).toBeDefined();
  fireEvent.contextMenu(clip!);
}

function mockClipRect(container: HTMLElement, clipName: string): HTMLElement {
  const clip = Array.from(container.querySelectorAll<HTMLElement>(".production-clip")).find(
    (el) => el.textContent?.includes(clipName),
  )!;
  clip.getBoundingClientRect = () =>
    ({
      left: 100,
      right: 300,
      width: 200,
      top: 0,
      bottom: 24,
      height: 24,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return clip;
}

function selectRazorTool(container: HTMLElement): void {
  const razor = Array.from(container.querySelectorAll<HTMLButtonElement>(".production-timeline-tool")).find(
    (button) => button.title === "Razor tool",
  );
  expect(razor).toBeDefined();
  fireEvent.click(razor!);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ProductionDrawer clip context menu", () => {
  it("keeps the program monitor visible when the timeline is empty", () => {
    const emptyTimeline: TimelineModel = {
      ...timeline,
      tracks: timeline.tracks.map((track) => ({ ...track, clips: [] })),
    };
    const store = seededStore({ timeline: emptyTimeline });
    const { container, getByTestId } = renderDrawer(store);

    expect(getByTestId("program-monitor")).toBeDefined();
    expect(container.querySelector(".production-timeline-track-card")).toBeDefined();
    expect(container.querySelector(".production-timeline-empty")).toBeNull();
  });

  it("uses the razor tool to split a clip at the clicked position", () => {
    const store = seededStore();
    const { container } = renderDrawer(store);
    selectRazorTool(container);
    const clip = mockClipRect(container, "a.mp4");
    fireEvent.click(clip, { clientX: 150 });

    const videoTrack = store.getState().timeline.tracks.find((track) => track.id === "track-v1")!;
    expect(videoTrack.clips).toHaveLength(3);
    expect(videoTrack.clips[0].duration).toBe(2.5);
    expect(videoTrack.clips[1].start).toBe(2.5);
    expect(videoTrack.clips[1].duration).toBe(7.5);
  });

  it("does not split when the razor click is too close to the clip edge", () => {
    const store = seededStore();
    const { container } = renderDrawer(store);
    selectRazorTool(container);
    const clip = mockClipRect(container, "a.mp4");
    fireEvent.click(clip, { clientX: 101 });

    const videoTrack = store.getState().timeline.tracks.find((track) => track.id === "track-v1")!;
    expect(videoTrack.clips).toHaveLength(2);
  });

  it("offers split-to-layers on a video clip and forwards the clip id", () => {
    const splitClipToLayers = vi.fn();
    const ports = drawerPorts();
    ports.editorLauncher.splitClipToLayers = splitClipToLayers;
    const { container } = renderDrawer(seededStore(), ports);
    openClipMenu(container, "a.mp4");
    const menu = container.querySelector(".production-clip-menu")!;
    const split = Array.from(menu.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Split to layers"),
    );
    expect(split).toBeDefined();
    fireEvent.click(split!);
    expect(splitClipToLayers).toHaveBeenCalledWith("clip-video");
    // choosing an action closes the menu
    expect(container.querySelector(".production-clip-menu")).toBeNull();
  });

  it("offers split-to-layers on a still clip", () => {
    const splitClipToLayers = vi.fn();
    const ports = drawerPorts();
    ports.editorLauncher.splitClipToLayers = splitClipToLayers;
    const { container } = renderDrawer(seededStore(), ports);
    openClipMenu(container, "b.png");
    const menu = container.querySelector(".production-clip-menu")!;
    const split = Array.from(menu.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Split to layers"),
    );
    expect(split).toBeDefined();
    fireEvent.click(split!);
    expect(splitClipToLayers).toHaveBeenCalledWith("clip-still");
  });

  it("does not offer split-to-layers on an audio clip", () => {
    const { container } = renderDrawer(seededStore());
    openClipMenu(container, "c.wav");
    const menu = container.querySelector(".production-clip-menu")!;
    const labels = Array.from(menu.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels.some((l) => l?.includes("Split to layers"))).toBe(false);
  });

  it("renders grouped keyframe diamonds for the selected clip and double-click deletes them", () => {
    const clipProperties: ClipProperties = {
      ...defaultClipProperties(),
      tracks: {
        "transform.scalePct": [{ t: 2, v: 80 }],
        "transform.opacityPct": [{ t: 2, v: 50 }],
        "crop.leftPct": [{ t: 4, v: 10 }],
      },
    };
    const store = seededStore({
      selectedClipId: "clip-video",
      clipProps: { "clip-video": clipProperties },
    });
    const { container } = renderDrawer(store);
    const diamonds = container.querySelectorAll<HTMLElement>(".production-clip-keyframe");
    expect(diamonds).toHaveLength(2);
    expect(diamonds[0].getAttribute("aria-label")).toContain("2 keyframe(s)");

    fireEvent.doubleClick(diamonds[0]);
    const next = store.getState().clipProps["clip-video"];
    expect(next.tracks?.["transform.scalePct"]).toBeUndefined();
    expect(next.tracks?.["transform.opacityPct"]).toBeUndefined();
    expect(next.tracks?.["crop.leftPct"]).toEqual([{ t: 4, v: 10 }]);
  });

  it("gives keyframe diamonds their own click target without toggling clip selection", () => {
    const clipProperties: ClipProperties = {
      ...defaultClipProperties(),
      tracks: {
        "transform.scalePct": [{ t: 2, v: 80 }],
      },
    };
    const store = seededStore({
      selectedClipId: "clip-video",
      clipProps: { "clip-video": clipProperties },
    });
    const { container } = renderDrawer(store);
    const diamond = container.querySelector<HTMLButtonElement>(".production-clip-keyframe")!;
    expect(diamond.tagName).toBe("BUTTON");

    const before = store.getState();
    fireEvent.click(diamond);
    expect(store.getState().selectedClipId).toBe("clip-video");
    expect(store.getState().clipProps).toBe(before.clipProps);
  });

  it("drags a keyframe group and Shift-snaps it to timeline snap points", () => {
    const clipProperties: ClipProperties = {
      ...defaultClipProperties(),
      tracks: {
        "transform.scalePct": [{ t: 2, v: 80, interp: "hold" }],
      },
    };
    const store = seededStore({
      selectedClipId: "clip-video",
      clipProps: { "clip-video": clipProperties },
    });
    const { container } = renderDrawer(store);
    const clip = mockClipRect(container, "a.mp4");
    const diamond = clip.querySelector<HTMLElement>(".production-clip-keyframe")!;

    fireEvent.pointerDown(diamond, { button: 0, pointerId: 7, clientX: 140 });
    fireEvent.pointerMove(diamond, {
      pointerId: 7,
      clientX: 256,
      shiftKey: true,
    });
    fireEvent.pointerUp(diamond, { pointerId: 7 });

    expect(store.getState().clipProps["clip-video"].tracks?.["transform.scalePct"]).toEqual([
      { t: 8, v: 80, interp: "hold" },
    ]);
  });
});
