// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LayerReviewPanel } from "./LayerReviewPanel";
import {
  STUB_BACKGROUND_LAYER_ID,
  STUB_ORIGINAL_LAYER_ID,
  STUB_SUBJECT_LAYER_ID,
  stubLayeredImageAsset,
} from "./layeredImage";

const asset = stubLayeredImageAsset({ imagePath: "/a/b.png", nodeId: "n1", createdAt: "0" });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("LayerReviewPanel", () => {
  it("lists the whole asset plus every candidate layer", () => {
    const { container } = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={null}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
      />,
    );
    const items = container.querySelectorAll(".layer-review-item");
    // whole-asset row + 3 stub layers
    expect(items).toHaveLength(4);
    expect(container.textContent).toContain("original image");
    expect(container.textContent).toContain("background candidate");
    expect(container.textContent).toContain("subject candidate");
    // whole-asset row is active when no layer is selected
    expect(container.querySelector("li.active .layer-review-item")?.textContent).toContain(
      "composite",
    );
  });

  it("selects a layer and reselects the whole asset on second click", () => {
    const onSelectLayer = vi.fn();
    const { container } = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={STUB_SUBJECT_LAYER_ID}
        onSelectLayer={onSelectLayer}
        visibility={{}}
        onToggleVisibility={() => {}}
      />,
    );
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>(".layer-review-item"));
    // click background candidate (index 2: whole asset, original, background, subject)
    fireEvent.click(items[2]);
    expect(onSelectLayer).toHaveBeenCalledWith(STUB_BACKGROUND_LAYER_ID);
    // clicking the already-selected subject layer clears back to the whole asset
    fireEvent.click(items[3]);
    expect(onSelectLayer).toHaveBeenCalledWith(null);
  });

  it("marks the locked original and surfaces split-report review issues", () => {
    const { container } = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={null}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
      />,
    );
    expect(container.querySelectorAll(".layer-review-locked")).toHaveLength(1);
    // one review badge each for the background and subject candidates
    expect(container.querySelectorAll(".layer-review-issues")).toHaveLength(2);
    expect(container.querySelector(".layer-review-warnings")?.textContent).toContain("stub split");
  });

  it("toggles visibility with overrides on top of the layer's own flag", () => {
    const onToggleVisibility = vi.fn();
    const { container } = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={null}
        onSelectLayer={() => {}}
        visibility={{ [STUB_ORIGINAL_LAYER_ID]: false }}
        onToggleVisibility={onToggleVisibility}
      />,
    );
    const toggles = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".layer-review-visibility"),
    );
    expect(toggles).toHaveLength(3);
    expect(toggles[0].getAttribute("aria-pressed")).toBe("false");
    expect(toggles[1].getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggles[1]);
    expect(onToggleVisibility).toHaveBeenCalledWith(STUB_BACKGROUND_LAYER_ID);
  });
});
