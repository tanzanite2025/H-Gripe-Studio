// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ViewportFrameLayer, viewportFrameWindowStyle } from "./ViewportFrameLayer";

afterEach(cleanup);

describe("ViewportFrameLayer", () => {
  it("places the native anchor and browser frame in the same viewport window", () => {
    expect(viewportFrameWindowStyle({ zoom: 2, panX: 0.25, panY: 0.1 })).toEqual({
      left: "25%",
      top: "10%",
      width: "50%",
      height: "50%",
    });

    const { container } = render(
      <ViewportFrameLayer
        frameUrl="frame-a"
        frameView={{ zoom: 2, panX: 0.25, panY: 0.1 }}
        overlayOnly={false}
        nativeSurfacePlacementAnchorRef={{ current: null }}
      />,
    );

    const anchor = container.querySelector(".image-editor-native-surface-anchor") as HTMLDivElement;
    const image = container.querySelector(".image-editor-viewport-frame-img") as HTMLImageElement;
    expect(anchor.style.cssText).toBe(image.style.cssText);
    expect(image.getAttribute("src")).toBe("frame-a");
  });

  it("replaces the already-decoded frame URL without a second load gate", () => {
    const props = {
      frameView: { zoom: 1, panX: 0, panY: 0 },
      overlayOnly: false,
      nativeSurfacePlacementAnchorRef: { current: null },
    };
    const { container, rerender } = render(
      <ViewportFrameLayer {...props} frameUrl="frame-a" />,
    );
    const firstImage = container.querySelector(".image-editor-viewport-frame-img") as HTMLImageElement;

    rerender(<ViewportFrameLayer {...props} frameUrl="frame-b" />);
    const currentImage = container.querySelector(".image-editor-viewport-frame-img") as HTMLImageElement;
    expect(currentImage).not.toBe(firstImage);
    expect(currentImage.getAttribute("src")).toBe("frame-b");
  });

  it("keeps the native anchor while overlay-only suppresses browser pixels", () => {
    const { container } = render(
      <ViewportFrameLayer
        frameUrl="frame-a"
        frameView={{ zoom: 1, panX: 0, panY: 0 }}
        overlayOnly={true}
        nativeSurfacePlacementAnchorRef={{ current: null }}
      />,
    );

    expect(container.querySelector(".image-editor-native-surface-anchor")).not.toBeNull();
    expect(container.querySelector(".image-editor-viewport-frame-img")).toBeNull();
    expect((container.firstElementChild as HTMLElement).style.visibility).toBe("");
  });
});
