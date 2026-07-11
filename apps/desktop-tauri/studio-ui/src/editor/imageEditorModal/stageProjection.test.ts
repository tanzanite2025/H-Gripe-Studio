import { describe, expect, it } from "vitest";
import { fitFrameInStage, projectFrameInStage, projectedFrameStyle } from "./stageProjection";

describe("stageProjection", () => {
  it("fits a document frame inside the stage without stretching it", () => {
    expect(fitFrameInStage({ w: 1000, h: 800 }, 16 / 9)).toMatchObject({
      left: 0,
      top: 118.75,
      width: 1000,
      height: 562.5,
    });

    expect(fitFrameInStage({ w: 800, h: 1000 }, 1 / 2)).toMatchObject({
      left: 150,
      top: 0,
      width: 500,
      height: 1000,
    });
  });

  it("projects zoom and pan into a screen-space frame rect", () => {
    const rect = projectFrameInStage(
      { w: 1000, h: 800 },
      16 / 9,
      { zoom: 2, panX: 40, panY: -20 },
    );

    expect(rect).toMatchObject({
      left: -460,
      top: -182.5,
      width: 2000,
      height: 1125,
    });
  });

  it("returns a layout style without CSS scale for sharp SVG overlays", () => {
    const style = projectedFrameStyle({
      left: 10,
      top: 20,
      width: 300,
      height: 200,
    });

    expect(style).toMatchObject({
      inset: "auto",
      left: "10px",
      top: "20px",
      width: "300px",
      height: "200px",
    });
    expect(style).not.toHaveProperty("transform");
  });
});
