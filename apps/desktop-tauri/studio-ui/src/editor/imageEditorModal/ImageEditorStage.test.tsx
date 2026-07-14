// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectedLayerFrame } from "../selectedLayerFrame";
import { ImageEditorStage } from "./ImageEditorStage";

afterEach(cleanup);

const selectedLayerFrame: SelectedLayerFrame = {
  owner: "selected-layer-frame",
  shape: "axis-aligned-rect",
  layerId: "layer-a",
  rect: [10, 20, 30, 40],
  sourceRect: [10, 20, 30, 40],
  source: "asset-frame",
};

interface StageHarnessProps {
  dims?: { w: number; h: number };
  stageSize?: { w: number; h: number };
  renderFrame?: { x: number; y: number; w: number; h: number };
  logicalPasteboard?: { x: number; y: number; w: number; h: number };
  cropView?: { region: [number, number, number, number] } | null;
  viewportFrameUrl?: string | null;
  overlayOnly?: boolean;
  isNativeSurfacePresented?: boolean;
  selectedLayerFrameValue?: SelectedLayerFrame | null;
  spacePan?: boolean;
  onPointerDownValue?: (event: ReactPointerEvent) => void;
  onPointerMoveValue?: (event: ReactPointerEvent) => void;
  onPointerUpValue?: () => void;
}

function StageHarness({
  dims = { w: 100, h: 100 },
  stageSize = { w: 200, h: 200 },
  renderFrame = { x: 0, y: 0, w: 100, h: 100 },
  logicalPasteboard = renderFrame,
  cropView = null,
  viewportFrameUrl = "data:image/png;base64,frame-a",
  overlayOnly = false,
  isNativeSurfacePresented = false,
  selectedLayerFrameValue = selectedLayerFrame,
  spacePan = false,
  onPointerDownValue = () => undefined,
  onPointerMoveValue = () => undefined,
  onPointerUpValue = () => undefined,
}: StageHarnessProps) {
  return (
    <ImageEditorStage
      stageRef={{ current: null }}
      canvasRef={{ current: null }}
      dims={dims}
      renderFrame={renderFrame}
      logicalPasteboard={logicalPasteboard}
      stageSize={stageSize}
      documentAvailable={true}
      view={{ zoom: 1, panX: 0, panY: 0 }}
      viewportFrameUrl={viewportFrameUrl}
      isNativeSurfacePresented={isNativeSurfacePresented}
      nativeSurfacePlacementAnchorRef={{ current: null }}
      viewportFrameView={{ zoom: 1, panX: 0, panY: 0 }}
      viewportBackend={null}
      overlayOnly={overlayOnly}
      cropView={cropView}
      spacePan={spacePan}
      toolId="move"
      onPointerDown={onPointerDownValue}
      onPointerMove={onPointerMoveValue}
      onPointerUp={onPointerUpValue}
      onContextMenu={() => undefined}
      brushCursor={null}
      brushCursorRef={{ current: null }}
      liveSelectionOverlayRef={{ current: null }}
      selectedLayerFrame={selectedLayerFrameValue}
      contextActionBar={<div data-testid="context-action-bar" />}
    />
  );
}

describe("ImageEditorStage selected-layer frame presentation", () => {
  it("projects pasteboard pixels and document interaction through the same logical world", () => {
    const fullDocumentFrame: SelectedLayerFrame = {
      ...selectedLayerFrame,
      rect: [0, 0, 800, 800],
      sourceRect: [0, 0, 800, 800],
    };
    const { container } = render(
      <StageHarness
        dims={{ w: 800, h: 800 }}
        stageSize={{ w: 1000, h: 800 }}
        renderFrame={{ x: 0, y: 0, w: 800, h: 800 }}
        logicalPasteboard={{ x: -600, y: -600, w: 2000, h: 2000 }}
        selectedLayerFrameValue={fullDocumentFrame}
      />,
    );
    const world = container.querySelector(".image-editor-world") as HTMLDivElement;
    expect(world.style.left).toBe("-500px");
    expect(world.style.top).toBe("-600px");
    expect(world.style.width).toBe("2000px");
    expect(world.style.height).toBe("2000px");
    const documentLayer = container.querySelector(".image-editor-document-layer") as HTMLDivElement;
    const pixelLayer = container.querySelector(".image-editor-pixel-layer") as HTMLDivElement;
    const interactionLayer = container.querySelector(".mask-interaction-result-layer");
    expect(world.contains(pixelLayer)).toBe(true);
    expect(documentLayer.contains(pixelLayer)).toBe(false);
    expect(documentLayer.contains(interactionLayer)).toBe(true);
    expect(container.querySelector(".selected-layer-frame-line")?.getAttribute("width")).toBe("800");
  });

  it("keeps full-document pixels and geometry together inside a crop window", () => {
    const { container } = render(
      <StageHarness
        dims={{ w: 800, h: 800 }}
        stageSize={{ w: 1000, h: 800 }}
        renderFrame={{ x: 0, y: 0, w: 800, h: 800 }}
        logicalPasteboard={{ x: -600, y: -600, w: 2000, h: 2000 }}
        cropView={{ region: [200, 200, 600, 600] }}
      />,
    );
    const cropFrame = container.querySelector(".image-editor-frame.cropped") as HTMLDivElement;
    const documentLayer = container.querySelector(".image-editor-document-layer") as HTMLDivElement;
    const pixelLayer = container.querySelector(".image-editor-pixel-layer") as HTMLDivElement;
    expect(cropFrame.style.left).toBe("40%");
    expect(cropFrame.style.width).toBe("20%");
    expect(documentLayer.style.left).toBe("-50%");
    expect(documentLayer.style.width).toBe("200%");
    expect(pixelLayer.style.clipPath).toBe("inset(40% 40% 40% 40%)");
  });

  it("publishes decoded browser pixels and their frame atomically", () => {
    const movedFrame: SelectedLayerFrame = {
      ...selectedLayerFrame,
      rect: [18, 25, 38, 45],
    };
    const { container, rerender } = render(<StageHarness />);
    expect(container.querySelector(".selected-layer-frame-line")?.getAttribute("x")).toBe("10");

    rerender(
      <StageHarness
        viewportFrameUrl="data:image/png;base64,frame-b"
        selectedLayerFrameValue={movedFrame}
      />,
    );
    expect(container.querySelector(".selected-layer-frame-line")?.getAttribute("x")).toBe("18");
    expect(container.querySelector(".selected-layer-move-surface")).toBeNull();
  });

  it("draws neither frame nor actions when pixels are absent or overlay-only", () => {
    const absent = render(<StageHarness viewportFrameUrl={null} />);
    expect(absent.container.querySelector(".selected-layer-frame-line")).toBeNull();
    expect(absent.queryByTestId("context-action-bar")).toBeNull();
    absent.unmount();

    const overlay = render(<StageHarness overlayOnly={true} />);
    expect(overlay.container.querySelector(".selected-layer-frame-line")).toBeNull();
    expect(overlay.queryByTestId("context-action-bar")).toBeNull();
  });

  it("uses native surface presentation and frame metadata as one result", () => {
    const { container } = render(
      <StageHarness viewportFrameUrl={null} isNativeSurfacePresented={true} />,
    );
    expect(container.querySelector(".selected-layer-frame-line")?.getAttribute("x")).toBe("10");
  });

  it("starts space-pan from the pasteboard without double-handling canvas input", () => {
    const onPointerDown = vi.fn();
    const onPointerMove = vi.fn();
    const onPointerUp = vi.fn();
    const { container } = render(
      <StageHarness
        spacePan={true}
        onPointerDownValue={onPointerDown}
        onPointerMoveValue={onPointerMove}
        onPointerUpValue={onPointerUp}
      />,
    );
    const pasteboard = container.querySelector(".image-editor-pasteboard-boundary") as HTMLDivElement;
    fireEvent.pointerDown(pasteboard);
    fireEvent.pointerMove(pasteboard);
    fireEvent.pointerUp(pasteboard);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerMove).toHaveBeenCalledTimes(1);
    expect(onPointerUp).toHaveBeenCalledTimes(1);

    onPointerDown.mockClear();
    fireEvent.pointerDown(container.querySelector(".image-editor-canvas") as HTMLCanvasElement);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("lets the move tool restart a drag from pixels outside the document child", () => {
    const onPointerDown = vi.fn();
    const { container } = render(<StageHarness onPointerDownValue={onPointerDown} />);

    fireEvent.pointerDown(container.querySelector(".image-editor-stage") as HTMLDivElement);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });
});
