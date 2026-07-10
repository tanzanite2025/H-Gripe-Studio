// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createBoxSelection } from "./selection";
import { SelectionOverlay } from "./SelectionOverlay";

describe("SelectionOverlay", () => {
  it("renders draft selections as non-scaling SVG strokes", () => {
    const { container } = render(
      <SelectionOverlay
        dims={{ w: 200, h: 100 }}
        draft={createBoxSelection([10, 20, 80, 90])}
      />,
    );

    const svg = container.querySelector("svg.mask-selection-overlay");
    const draft = container.querySelector(".mask-selection-draft-path");

    expect(svg?.getAttribute("viewBox")).toBe("0 0 200 100");
    expect(draft?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(container.querySelector(".mask-selection-ants-light")).toBeNull();
  });

  it("renders active selections as SVG marching ants instead of a canvas stroke", () => {
    const { container } = render(
      <SelectionOverlay
        dims={{ w: 200, h: 100 }}
        active={{ region: [10, 20, 80, 90], ellipse: false }}
        phase={4}
      />,
    );

    const light = container.querySelector(".mask-selection-ants-light");
    const dark = container.querySelector(".mask-selection-ants-dark");

    expect(light?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(dark?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(light?.getAttribute("style")).toContain("stroke-dashoffset: -4");
    expect(dark?.getAttribute("style")).toContain("stroke-dashoffset: 1");
  });

  it("never renders a solid draft and marching ants at the same time", () => {
    const { container } = render(
      <SelectionOverlay
        dims={{ w: 200, h: 100 }}
        draft={createBoxSelection([10, 20, 80, 90])}
        active={{ region: [30, 30, 60, 60], ellipse: false }}
        phase={4}
      />,
    );

    expect(container.querySelector(".mask-selection-draft-path")).not.toBeNull();
    expect(container.querySelector(".mask-selection-ants-light")).toBeNull();
    expect(container.querySelector(".mask-selection-ants-dark")).toBeNull();
  });
});
