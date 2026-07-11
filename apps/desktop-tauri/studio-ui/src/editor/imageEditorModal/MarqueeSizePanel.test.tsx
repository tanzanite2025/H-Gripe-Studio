// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarqueeSizePanel } from "./MarqueeSizePanel";

function canvasWithRect(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return canvas;
}

describe("MarqueeSizePanel", () => {
  it("commits the marquee draft when the primary action is clicked", () => {
    const makeSelection = vi.fn();
    const { container } = render(
      <MarqueeSizePanel
        draftSelection={{ region: [10, 10, 60, 40], ellipse: false, status: "closed" }}
        draft={{ w: 50, h: 30 }}
        setDraft={vi.fn()}
        makeSelection={makeSelection}
        cancelDraft={vi.fn()}
        dims={{ w: 100, h: 100 }}
        frame={{ x: 0, y: 0, w: 100, h: 100 }}
        canvasEl={canvasWithRect()}
      />,
    );

    fireEvent.click(container.querySelector("button.primary")!);

    expect(makeSelection).toHaveBeenCalledWith(50, 30);
  });

  it("anchors the panel from the visible scene frame, not the whole document", () => {
    const { container } = render(
      <MarqueeSizePanel
        draftSelection={{ region: [60, 70, 80, 90], ellipse: false, status: "closed" }}
        draft={{ w: 20, h: 20 }}
        setDraft={vi.fn()}
        makeSelection={vi.fn()}
        cancelDraft={vi.fn()}
        dims={{ w: 200, h: 200 }}
        frame={{ x: 50, y: 50, w: 100, h: 100 }}
        canvasEl={canvasWithRect()}
      />,
    );

    const panel = container.querySelector<HTMLElement>(".mask-marquee-float")!;

    expect(panel.style.left).toBe("140px");
    expect(panel.style.top).toBe("50px");
  });
});
