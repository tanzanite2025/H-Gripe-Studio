import { describe, expect, it } from "vitest";

import { CropEditModal } from "./CropEditModal";
import { ImageEditorModal } from "./ImageEditorModal";
import { ImageSourceEditorModal } from "./ImageSourceEditorModal";

describe("software editor display-source boundary", () => {
  it("keeps node_output preview targets out of software-level editor underlays", () => {
    for (const component of [ImageEditorModal, CropEditModal]) {
      expect(String(component)).not.toContain("useNodeOutputSource");
    }
  });

  it("does not forward graph node context into the unified image editor canvas", () => {
    expect(String(ImageSourceEditorModal)).not.toContain("nodeId");
  });
});
