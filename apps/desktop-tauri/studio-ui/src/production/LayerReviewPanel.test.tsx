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

  it("shows a protected badge and toggles protection on unlocked layers", () => {
    const protectedAsset = {
      ...asset,
      layers: asset.layers.map((layer) =>
        layer.id === STUB_SUBJECT_LAYER_ID ? { ...layer, protected: true } : layer,
      ),
    };
    const onToggleProtected = vi.fn();
    const { container } = render(
      <LayerReviewPanel
        asset={protectedAsset}
        selectedLayerId={null}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
        onToggleProtected={onToggleProtected}
      />,
    );
    expect(container.querySelectorAll(".layer-review-protected")).toHaveLength(1);
    // protect toggles on the unlocked layers only (background + subject)
    const toggles = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".layer-review-protect"),
    );
    expect(toggles).toHaveLength(2);
    expect(toggles[1].getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggles[0]);
    expect(onToggleProtected).toHaveBeenCalledWith(STUB_BACKGROUND_LAYER_ID);
  });

  it("hides protect toggles when the callback is omitted", () => {
    const { container } = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={null}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
      />,
    );
    expect(container.querySelector(".layer-review-protect")).toBeNull();
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

  it("previews the composite for the whole asset and toggles layer/mask when a layer is selected", () => {
    const whole = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={null}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
      />,
    );
    expect(whole.container.querySelector(".layer-review-preview")).not.toBeNull();
    // no layer selected -> composite preview, no mask toggle
    expect(whole.container.querySelector(".layer-review-preview-toggle")).toBeNull();
    expect(
      whole.container.querySelector(".layer-review-preview-stage")?.getAttribute("title"),
    ).toBe(asset.preview_composite.path);

    const selected = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={STUB_SUBJECT_LAYER_ID}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
      />,
    );
    const toggle = selected.container.querySelector<HTMLButtonElement>(
      ".layer-review-preview-toggle",
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle!);
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
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

  it("merges checked unlocked layers when a merge handler is provided", () => {
    const onMergeLayers = vi.fn();
    const { container } = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={null}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
        onMergeLayers={onMergeLayers}
      />,
    );
    // no checkbox on the locked original layer
    const checks = Array.from(
      container.querySelectorAll<HTMLInputElement>(".layer-review-check"),
    );
    expect(checks).toHaveLength(2);
    const merge = container.querySelector<HTMLButtonElement>(".layer-review-merge");
    expect(merge).not.toBeNull();
    expect(merge!.disabled).toBe(true);
    fireEvent.click(checks[0]);
    expect(merge!.disabled).toBe(true);
    fireEvent.click(checks[1]);
    expect(merge!.disabled).toBe(false);
    fireEvent.click(merge!);
    expect(onMergeLayers).toHaveBeenCalledWith([
      STUB_BACKGROUND_LAYER_ID,
      STUB_SUBJECT_LAYER_ID,
    ]);
    // selection clears after the merge request
    expect(merge!.disabled).toBe(true);
  });

  it("splits the selected unlocked layer when a split handler is provided", () => {
    const onSplitLayer = vi.fn();
    const noSelection = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={null}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
        onSplitLayer={onSplitLayer}
      />,
    );
    const disabled = noSelection.container.querySelector<HTMLButtonElement>(".layer-review-split");
    expect(disabled).not.toBeNull();
    expect(disabled!.disabled).toBe(true);

    const lockedSelected = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={STUB_ORIGINAL_LAYER_ID}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
        onSplitLayer={onSplitLayer}
      />,
    );
    expect(
      lockedSelected.container.querySelector<HTMLButtonElement>(".layer-review-split")!.disabled,
    ).toBe(true);

    const { container } = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={STUB_SUBJECT_LAYER_ID}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
        onSplitLayer={onSplitLayer}
      />,
    );
    const split = container.querySelector<HTMLButtonElement>(".layer-review-split")!;
    expect(split.disabled).toBe(false);
    fireEvent.click(split);
    expect(onSplitLayer).toHaveBeenCalledWith(STUB_SUBJECT_LAYER_ID);
  });

  it("hides merge affordances without a merge handler (browser preview)", () => {
    const { container } = render(
      <LayerReviewPanel
        asset={asset}
        selectedLayerId={null}
        onSelectLayer={() => {}}
        visibility={{}}
        onToggleVisibility={() => {}}
      />,
    );
    expect(container.querySelector(".layer-review-check")).toBeNull();
    expect(container.querySelector(".layer-review-merge")).toBeNull();
  });
});
