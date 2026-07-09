// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MediaWorkspacePopover } from "./MediaWorkspacePopover";
import type { MediaAsset } from "./mediaBin";

const assets: MediaAsset[] = [
  { id: "asset-v", kind: "video", path: "/media/a.mp4", name: "a.mp4", addedAt: 0 },
  { id: "asset-i", kind: "image", path: "/media/b.png", name: "b.png", addedAt: 0 },
];

function renderPopover(overrides: Partial<Parameters<typeof MediaWorkspacePopover>[0]> = {}) {
  return render(
    <MediaWorkspacePopover
      assets={assets}
      activeAssetId={null}
      addableAsset={null}
      onAddSelected={() => {}}
      onImportMedia={() => {}}
      onClose={() => {}}
      onSelectAsset={() => {}}
      onRemoveAsset={() => {}}
      onOpenImageEdit={() => {}}
      onDragAssetChange={() => {}}
      {...overrides}
    />,
  );
}

describe("MediaWorkspacePopover", () => {
  it("exposes direct media import independently from selected-node import", () => {
    const onImportMedia = vi.fn();
    const onAddSelected = vi.fn();
    const { getByText } = renderPopover({ onImportMedia, onAddSelected });

    fireEvent.click(getByText("Import media…"));
    expect(onImportMedia).toHaveBeenCalledTimes(1);

    fireEvent.click(getByText("Add selected node"));
    expect(onAddSelected).not.toHaveBeenCalled();
  });

  it("keeps bin asset drag/drop wiring inside the extracted workspace", () => {
    const onSelectAsset = vi.fn();
    const onDragAssetChange = vi.fn();
    const { container } = renderPopover({ onSelectAsset, onDragAssetChange });
    const item = container.querySelector<HTMLButtonElement>(".production-bin-item")!;
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn(),
    };

    fireEvent.dragStart(item, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("application/x-hgripe-asset", "asset-v");
    expect(onSelectAsset).toHaveBeenCalledWith("asset-v");
    expect(onDragAssetChange).toHaveBeenCalledWith("asset-v");

    fireEvent.dragEnd(item);
    expect(onDragAssetChange).toHaveBeenLastCalledWith(null);
  });
});
