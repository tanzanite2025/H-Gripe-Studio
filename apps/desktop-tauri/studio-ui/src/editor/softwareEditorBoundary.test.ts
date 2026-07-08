import { describe, expect, it } from "vitest";

import { CropEditModal } from "./CropEditModal";
import { MaskEditModal } from "./MaskEditModal";
import { MediaEditModal } from "./MediaEditModal";

describe("software editor display-source boundary", () => {
  it("keeps node_output preview targets out of software-level editor underlays", () => {
    for (const component of [MaskEditModal, CropEditModal]) {
      expect(String(component)).not.toContain("useNodeOutputSource");
    }
  });

  it("does not forward graph node context into the unified image editor canvas", () => {
    expect(String(MediaEditModal)).not.toContain("nodeId");
  });
});
