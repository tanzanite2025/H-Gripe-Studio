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
        region={[10, 10, 60, 40]}
        draft={{ w: 50, h: 30 }}
        setDraft={vi.fn()}
        makeSelection={makeSelection}
        dims={{ w: 100, h: 100 }}
        canvasEl={canvasWithRect()}
      />,
    );

    fireEvent.click(container.querySelector("button.primary")!);

    expect(makeSelection).toHaveBeenCalledWith(50, 30);
  });
});
