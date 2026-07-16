// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageSourceEditorModal } from "./ImageSourceEditorModal";
import { emptyImageDocument, emptyImageLayer, type ImageDocument } from "./imageDocument";

vi.mock("./ImageEditorModal", () => ({
  ImageEditorModal: () => <div data-testid="image-editor" />,
}));

afterEach(cleanup);

function renderModal(initial: ImageDocument) {
  const onDocChange = vi.fn();
  const onCommitMask = vi.fn();
  const onClose = vi.fn();
  return {
    ...render(
      <ImageSourceEditorModal
        title="Source image"
        initial={initial}
        onDocChange={onDocChange}
        onCommitMask={onCommitMask}
        onCommitCrop={vi.fn()}
        onClose={onClose}
      />,
    ),
    onDocChange,
    onCommitMask,
    onClose,
  };
}

describe("ImageSourceEditorModal persisted draft guard", () => {
  it("blocks editing without mutating or emitting a retired-op draft", () => {
    const initial: ImageDocument = {
      ...emptyImageDocument(),
      layers: [
        {
          ...emptyImageLayer("Legacy grade"),
          layer: {
            kind: "adjustment",
            ops: [{ type: "lut3d", size: 2, data: [] }],
          } as unknown as ImageDocument["layers"][number]["layer"],
        },
      ],
    };
    const before = JSON.stringify(initial);
    const result = renderModal(initial);

    expect(screen.getByRole("alert").textContent).toContain("lut3d");
    expect(screen.queryByTestId("image-editor")).toBeNull();
    expect((screen.getByRole("button", { name: "Apply edits to the node" }) as HTMLButtonElement).disabled).toBe(true);
    expect(result.onDocChange).not.toHaveBeenCalled();
    expect(result.onCommitMask).not.toHaveBeenCalled();
    expect(JSON.stringify(initial)).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(result.onClose).toHaveBeenCalledTimes(1);
  });

  it("mounts the editor for a bridgeable draft", () => {
    renderModal(emptyImageDocument());
    expect(screen.getByTestId("image-editor")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
