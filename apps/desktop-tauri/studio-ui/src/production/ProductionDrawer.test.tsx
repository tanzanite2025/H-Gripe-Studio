// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MediaAsset } from "./mediaBin";
import { ProductionDrawer, type ProductionDrawerProps } from "./ProductionDrawer";
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
  tracks: [
    {
      id: "track-v1",
      kind: "video",
      clips: [
        { id: "clip-video", kind: "video", assetId: "asset-v", start: 0, duration: 10 },
        { id: "clip-still", kind: "still", assetId: "asset-i", start: 10, duration: 5 },
      ],
    },
    {
      id: "track-a1",
      kind: "audio",
      clips: [{ id: "clip-audio", kind: "audio", assetId: "asset-a", start: 0, duration: 8 }],
    },
  ],
};

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
  const clip = Array.from(container.querySelectorAll<HTMLButtonElement>(".production-clip")).find(
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
    expect(container.querySelector(".production-timeline-empty")?.textContent).toContain("Empty timeline");
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
});
