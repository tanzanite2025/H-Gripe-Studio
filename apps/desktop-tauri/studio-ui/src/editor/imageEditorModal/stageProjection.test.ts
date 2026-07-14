import { describe, expect, it } from "vitest";
import {
  fitFrameInStage,
  frameClipWithinWorldStyle,
  frameRectWithinWorld,
  frameWithinWorldStyle,
  projectCameraFrameInStage,
  projectedFrameStyle,
  projectWorldFrameInStage,
  viewportWindowForWorld,
} from "./stageProjection";

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
    const rect = projectCameraFrameInStage(
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

  it("fits an 800px square document without involving a logical pasteboard", () => {
    expect(projectCameraFrameInStage(
      { w: 1000, h: 800 },
      1,
      { zoom: 1, panX: 0, panY: 0 },
    )).toEqual({
      left: 100,
      top: 0,
      width: 800,
      height: 800,
    });
  });

  it("fits the document while projecting it inside a 2.5x logical world", () => {
    const world = { x: -600, y: -600, w: 2000, h: 2000 };
    const document = { x: 0, y: 0, w: 800, h: 800 };
    const projectedWorld = projectWorldFrameInStage(
      { w: 1000, h: 800 },
      world,
      document,
      { zoom: 1, panX: 0, panY: 0 },
    );

    expect(projectedWorld).toEqual({
      left: -500,
      top: -600,
      width: 2000,
      height: 2000,
    });
    expect(frameRectWithinWorld(document, world)).toEqual({
      left: 0.3,
      top: 0.3,
      width: 0.4,
      height: 0.4,
    });
    expect(frameWithinWorldStyle(document, world)).toEqual({
      inset: "auto",
      left: "30%",
      top: "30%",
      width: "40%",
      height: "40%",
    });

    const documentScreenLeft = projectedWorld!.left + projectedWorld!.width * 0.3;
    const documentScreenTop = projectedWorld!.top + projectedWorld!.height * 0.3;
    expect({ left: documentScreenLeft, top: documentScreenTop, width: projectedWorld!.width * 0.4 })
      .toEqual({ left: 100, top: 0, width: 800 });
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

  it("maps the visible stage window into the stable pasteboard scene", () => {
    const stage = { w: 1000, h: 800 };
    const world = { x: -600, y: -600, w: 2000, h: 2000 };
    const document = { x: 0, y: 0, w: 800, h: 800 };

    expect(viewportWindowForWorld(stage, world, document, {
      zoom: 1,
      panX: 0,
      panY: 0,
    })).toEqual({ zoom: 2, panX: 0.25, panY: 0.25 });
    expect(viewportWindowForWorld(stage, world, document, {
      zoom: 2,
      panX: 100,
      panY: -40,
    })).toEqual({ zoom: 4, panX: 0.35, panY: 0.385 });
    expect(viewportWindowForWorld(stage, world, document, {
      zoom: 2,
      panX: 100,
      panY: -40,
      rotate: 15,
    })).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it("clips pasteboard pixels only for an explicit crop frame", () => {
    expect(frameClipWithinWorldStyle(
      { x: 200, y: 200, w: 400, h: 400 },
      { x: -600, y: -600, w: 2000, h: 2000 },
    )).toEqual({ clipPath: "inset(40% 40% 40% 40%)" });
  });
});
