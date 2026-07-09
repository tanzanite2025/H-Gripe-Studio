// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { MediaAsset } from "./mediaBin";
import { ProductionDrawer, type ProductionDrawerProps } from "./ProductionDrawer";
import { defaultClipProperties, type ClipProperties } from "./clipProps";
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

function drawerProps(overrides: Partial<ProductionDrawerProps> = {}): ProductionDrawerProps {
  return {
    mode: "open",
    onSetMode: () => {},
    target: null,
    assets,
    activeAssetId: null,
    onSelectAsset: () => {},
    onRemoveAsset: () => {},
    addableAsset: null,
    onAddSelected: () => {},
    timeline,
    selectedClipId: null,
    onSelectClip: () => {},
    onAddActiveToTimeline: () => {},
    onAddActiveToTrack: () => {},
    onAddTrack: () => {},
    onRemoveTrack: () => {},
    onRemoveClip: () => {},
    onSplitClipAt: () => {},
    onOpenImageEdit: () => {},
    onOpenAudioEdit: () => {},
    onOpenClipGrade: () => {},
    onSplitClipToLayers: () => {},
    onOpenExport: () => {},
    layeredAsset: null,
    selectedLayerId: null,
    onSelectLayer: () => {},
    layerVisibility: {},
    onToggleLayerVisibility: () => {},
    ...overrides,
  };
}

function openClipMenu(container: HTMLElement, clipName: string): void {
  const clip = Array.from(container.querySelectorAll<HTMLElement>(".production-clip")).find(
    (el) => el.textContent?.includes(clipName),
  );
  expect(clip).toBeDefined();
  fireEvent.contextMenu(clip!);
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
    const { container, getByTestId } = render(
      <ProductionDrawer {...drawerProps({ timeline: emptyTimeline })} />,
    );

    expect(getByTestId("program-monitor")).toBeDefined();
    expect(container.querySelector(".production-timeline-track-card")).toBeDefined();
    expect(container.querySelector(".production-timeline-empty")).toBeNull();
  });

  it("uses the razor tool to split a clip at the clicked position", () => {
    const onSplitClipAt = vi.fn();
    const { container } = render(<ProductionDrawer {...drawerProps({ onSplitClipAt })} />);
    const razor = Array.from(container.querySelectorAll<HTMLButtonElement>(".production-timeline-tool")).find(
      (button) => button.title === "Razor tool",
    );
    expect(razor).toBeDefined();
    fireEvent.click(razor!);
    const clip = Array.from(container.querySelectorAll<HTMLElement>(".production-clip")).find(
      (el) => el.textContent?.includes("a.mp4"),
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
    fireEvent.click(clip, { clientX: 150 });
    expect(onSplitClipAt).toHaveBeenCalledWith("clip-video", 2.5);
  });

  it("does not split when the razor click is too close to the clip edge", () => {
    const onSplitClipAt = vi.fn();
    const { container } = render(<ProductionDrawer {...drawerProps({ onSplitClipAt })} />);
    const razor = Array.from(container.querySelectorAll<HTMLButtonElement>(".production-timeline-tool")).find(
      (button) => button.title === "Razor tool",
    );
    fireEvent.click(razor!);
    const clip = Array.from(container.querySelectorAll<HTMLElement>(".production-clip")).find(
      (el) => el.textContent?.includes("a.mp4"),
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
    fireEvent.click(clip, { clientX: 101 });
    expect(onSplitClipAt).not.toHaveBeenCalled();
  });

  it("offers split-to-layers on a video clip and forwards the clip id", () => {
    const onSplitClipToLayers = vi.fn();
    const { container } = render(<ProductionDrawer {...drawerProps({ onSplitClipToLayers })} />);
    openClipMenu(container, "a.mp4");
    const menu = container.querySelector(".production-clip-menu")!;
    const split = Array.from(menu.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Split to layers"),
    );
    expect(split).toBeDefined();
    fireEvent.click(split!);
    expect(onSplitClipToLayers).toHaveBeenCalledWith("clip-video");
    // choosing an action closes the menu
    expect(container.querySelector(".production-clip-menu")).toBeNull();
  });

  it("offers split-to-layers on a still clip", () => {
    const onSplitClipToLayers = vi.fn();
    const { container } = render(<ProductionDrawer {...drawerProps({ onSplitClipToLayers })} />);
    openClipMenu(container, "b.png");
    const menu = container.querySelector(".production-clip-menu")!;
    const split = Array.from(menu.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Split to layers"),
    );
    expect(split).toBeDefined();
    fireEvent.click(split!);
    expect(onSplitClipToLayers).toHaveBeenCalledWith("clip-still");
  });

  it("does not offer split-to-layers on an audio clip", () => {
    const { container } = render(<ProductionDrawer {...drawerProps()} />);
    openClipMenu(container, "c.wav");
    const menu = container.querySelector(".production-clip-menu")!;
    const labels = Array.from(menu.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels.some((l) => l?.includes("Split to layers"))).toBe(false);
  });

  it("renders grouped keyframe diamonds for the selected clip and double-click deletes them", () => {
    const onSetClipProperties = vi.fn();
    const clipProperties: ClipProperties = {
      ...defaultClipProperties(),
      tracks: {
        "transform.scalePct": [{ t: 2, v: 80 }],
        "transform.opacityPct": [{ t: 2, v: 50 }],
        "crop.leftPct": [{ t: 4, v: 10 }],
      },
    };
    const { container } = render(
      <ProductionDrawer
        {...drawerProps({
          selectedClipId: "clip-video",
          clipProperties,
          onSetClipProperties,
        })}
      />,
    );
    const diamonds = container.querySelectorAll<HTMLElement>(".production-clip-keyframe");
    expect(diamonds).toHaveLength(2);
    expect(diamonds[0].getAttribute("aria-label")).toContain("2 keyframe(s)");

    fireEvent.doubleClick(diamonds[0]);
    expect(onSetClipProperties).toHaveBeenCalledTimes(1);
    const next = onSetClipProperties.mock.calls[0][1] as ClipProperties;
    expect(next.tracks?.["transform.scalePct"]).toBeUndefined();
    expect(next.tracks?.["transform.opacityPct"]).toBeUndefined();
    expect(next.tracks?.["crop.leftPct"]).toEqual([{ t: 4, v: 10 }]);
  });

  it("gives keyframe diamonds their own click target without toggling clip selection", () => {
    const onSelectClip = vi.fn();
    const onSetClipProperties = vi.fn();
    const clipProperties: ClipProperties = {
      ...defaultClipProperties(),
      tracks: {
        "transform.scalePct": [{ t: 2, v: 80 }],
      },
    };
    const { container } = render(
      <ProductionDrawer
        {...drawerProps({
          selectedClipId: "clip-video",
          clipProperties,
          onSelectClip,
          onSetClipProperties,
        })}
      />,
    );
    const diamond = container.querySelector<HTMLButtonElement>(".production-clip-keyframe")!;
    expect(diamond.tagName).toBe("BUTTON");

    fireEvent.click(diamond);
    expect(onSelectClip).not.toHaveBeenCalled();
    expect(onSetClipProperties).not.toHaveBeenCalled();
  });

  it("drags a keyframe group and Shift-snaps it to timeline snap points", () => {
    const onSetClipProperties = vi.fn();
    const clipProperties: ClipProperties = {
      ...defaultClipProperties(),
      tracks: {
        "transform.scalePct": [{ t: 2, v: 80, interp: "hold" }],
      },
    };
    const { container } = render(
      <ProductionDrawer
        {...drawerProps({
          selectedClipId: "clip-video",
          clipProperties,
          onSetClipProperties,
        })}
      />,
    );
    const clip = Array.from(container.querySelectorAll<HTMLElement>(".production-clip")).find(
      (el) => el.textContent?.includes("a.mp4"),
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
    const diamond = clip.querySelector<HTMLElement>(".production-clip-keyframe")!;

    fireEvent.pointerDown(diamond, { button: 0, pointerId: 7, clientX: 140 });
    fireEvent.pointerMove(diamond, {
      pointerId: 7,
      clientX: 256,
      shiftKey: true,
    });
    fireEvent.pointerUp(diamond, { pointerId: 7 });

    expect(onSetClipProperties).toHaveBeenCalled();
    const lastCall = onSetClipProperties.mock.calls[onSetClipProperties.mock.calls.length - 1];
    const next = lastCall[1] as ClipProperties;
    expect(next.tracks?.["transform.scalePct"]).toEqual([
      { t: 8, v: 80, interp: "hold" },
    ]);
  });
});
