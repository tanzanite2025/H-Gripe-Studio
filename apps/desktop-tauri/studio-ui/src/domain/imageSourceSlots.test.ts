import { describe, expect, it } from "vitest";

import {
  appendImageSourcePaths,
  firstImageSourceSlotPortId,
  imageSourceOutputPort,
  imageSourceParamsFromPaths,
  MAX_IMAGE_SOURCE_SLOTS,
  imageSourceSlotColorForPort,
  normalizeImageSourceSlots,
} from "./imageSourceSlots";

describe("image source slots", () => {
  it("normalizes legacy path params into slot A", () => {
    const slots = normalizeImageSourceSlots({ path: "/a/main.png" });
    expect(slots).toMatchObject([
      {
        id: "slot-a",
        label: "A",
        role: "main",
        path: "/a/main.png",
      },
    ]);
    expect(firstImageSourceSlotPortId({ path: "/a/main.png" })).toBe("image:slot-a");
    expect(imageSourceOutputPort({ path: "/a/main.png" }, "image:slot-a")).toEqual({
      id: "image:slot-a",
      label: "A",
      type: "image",
    });
  });

  it("keeps each image as a stable colored slot", () => {
    const params = imageSourceParamsFromPaths(["/a/main.png", "/a/ref.png"]);
    const slots = normalizeImageSourceSlots(params);
    expect(slots.map((slot) => [slot.id, slot.label, slot.path])).toEqual([
      ["slot-a", "A", "/a/main.png"],
      ["slot-b", "B", "/a/ref.png"],
    ]);
    expect(imageSourceSlotColorForPort(params, "image:slot-b")).toBe(slots[1].color);
    expect(imageSourceOutputPort(params, "image:slot-b")).toEqual({
      id: "image:slot-b",
      label: "B",
      type: "image",
    });
  });

  it("caps a single image source card at five slots", () => {
    const params = imageSourceParamsFromPaths([
      "/a/1.png",
      "/a/2.png",
      "/a/3.png",
      "/a/4.png",
      "/a/5.png",
      "/a/6.png",
    ]);
    const slots = normalizeImageSourceSlots(params);
    expect(slots).toHaveLength(MAX_IMAGE_SOURCE_SLOTS);
    expect(slots.map((slot) => slot.label)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("appends paths into remaining slots without renumbering existing images", () => {
    const params = imageSourceParamsFromPaths(["/a/main.png", "/a/ref.png"]);
    const next = appendImageSourcePaths(params, ["/a/mask.png", "/a/pose.png"]);
    expect(normalizeImageSourceSlots(next).map((slot) => [slot.id, slot.path])).toEqual([
      ["slot-a", "/a/main.png"],
      ["slot-b", "/a/ref.png"],
      ["slot-c", "/a/mask.png"],
      ["slot-d", "/a/pose.png"],
    ]);
  });
});
