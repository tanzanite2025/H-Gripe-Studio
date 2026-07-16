import { describe, expect, it } from "vitest";

import { emptyImageDocument, emptyImageLayer, type ImageDocument, type ImageLayer } from "./imageDocument";
import { imageDocumentEditBlock, isPersistedImageDocumentEnvelope } from "./imageDocumentEditGuard";

function adjustmentLayer(name: string, ops: unknown[]): ImageLayer {
  return {
    ...emptyImageLayer(name),
    layer: { kind: "adjustment", ops } as ImageLayer["layer"],
  };
}

describe("persisted image document edit guard", () => {
  it("finds a retired grade operation recursively inside layer groups", () => {
    const document: ImageDocument = {
      ...emptyImageDocument(),
      layers: [
        {
          ...emptyImageLayer("Folder"),
          layer: {
            kind: "group",
            children: [adjustmentLayer("Legacy colour", [{ type: "lut1d", values: [] }])],
          },
        },
      ],
    };

    expect(imageDocumentEditBlock(document)).toEqual({
      code: "unsupported-grade-op",
      detail: 'Layer "Folder / Legacy colour" contains unsupported or retired grade operation "lut1d".',
    });
  });

  it("blocks supported grade operations that the current image editor cannot rewrite", () => {
    const document = {
      ...emptyImageDocument(),
      layers: [adjustmentLayer("Exposure", [{ type: "exposure", ev: 1 }])],
    };

    expect(imageDocumentEditBlock(document)).toEqual({
      code: "grade-ops-not-rewriteable",
      detail: 'Layer "Exposure" contains grade operations that this image editor cannot rewrite safely.',
    });
  });

  it("allows bridgeable drafts while rejecting malformed envelopes", () => {
    expect(imageDocumentEditBlock(emptyImageDocument())).toBeNull();
    expect(isPersistedImageDocumentEnvelope({ version: 1, layers: [] })).toBe(true);
    expect(imageDocumentEditBlock({ version: 1, layers: [{ name: "Broken" }] })).toMatchObject({
      code: "invalid-document",
    });
    expect(isPersistedImageDocumentEnvelope({ version: 2, layers: [] })).toBe(false);
  });
});
