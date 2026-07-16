import { describe, expect, it } from "vitest";
import { compileImageAdjustments } from "./imageCompile";
import { applyDoc } from "./gradeKernel";
import type { GradeSurface } from "./gradeKernel";
import { adjustmentToneMapper } from "./maskMorphology";
import { emptyImageDocument, emptyImageLayer, type ImageDocument, type ImageLayer } from "./imageDocument";
import { type LayerAdjustment } from "../contracts/imageEditorDocument";

function adjustmentLayer(adjustment: LayerAdjustment, opts?: Partial<ImageLayer>): ImageLayer {
  return { ...emptyImageLayer(adjustment.type), layer: { kind: "adjustment", adjustment }, ...opts };
}

function docWith(layers: ImageLayer[]): ImageDocument {
  return { ...emptyImageDocument(), layers };
}

function rampSurface(): GradeSurface {
  const data = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 1;
  }
  return { w: 256, h: 1, data, space: "srgb" };
}

describe("compileImageAdjustments", () => {
  it("compiles a pixel base + adjustment stack to grade layers", () => {
    const doc = docWith([
      emptyImageLayer(),
      adjustmentLayer({ type: "levels", in_black: 20 }, { opacity: 0.7 }),
      adjustmentLayer({ type: "color_ranges", monochrome: true }),
    ]);
    const grade = compileImageAdjustments(doc);
    expect(grade?.layers).toHaveLength(2);
    expect(grade?.layers[0]).toMatchObject({ blend: "normal", opacity: 0.7, visible: true, mask: null });
    expect(grade?.layers[0].ops[0].type).toBe("levels");
    expect(grade?.layers[1].ops[0].type).toBe("color_ranges");
  });

  it("rendering the compiled doc matches the mask kernel's opacity lerp", () => {
    const adj: LayerAdjustment = { type: "levels", in_black: 30, gamma: 1.6, out_white: 240 };
    const opacity = 0.6;
    const grade = compileImageAdjustments(docWith([emptyImageLayer(), adjustmentLayer(adj, { opacity })]));
    expect(grade).not.toBeNull();
    const surface = rampSurface();
    applyDoc(grade!, surface);
    const mapValue = adjustmentToneMapper(adj);
    for (let i = 0; i < 256; i++) {
      const want = (i + (mapValue(i) - i) * opacity) / 255;
      expect(Math.abs(surface.data[i * 4] * 255 - want * 255), `level ${i}`).toBeLessThanOrEqual(0.5 + 1e-3);
    }
  });

  it("returns null for stacks the grade kernel cannot express yet", () => {
    // A visible pixel layer above a visible adjustment.
    expect(
      compileImageAdjustments(
        docWith([emptyImageLayer(), adjustmentLayer({ type: "curve", points: [[0, 10], [255, 250]] }), emptyImageLayer("Layer 1")]),
      ),
    ).toBeNull();
    // Groups and layer/clipping masks are K3+.
    expect(
      compileImageAdjustments(docWith([{ ...emptyImageLayer(), layer: { kind: "group", children: [] } }])),
    ).toBeNull();
    expect(compileImageAdjustments(docWith([{ ...emptyImageLayer(), clipped: true }]))).toBeNull();
    expect(compileImageAdjustments(docWith([{ ...emptyImageLayer(), mask: { path: "m.png" } }]))).toBeNull();
    expect(
      compileImageAdjustments(docWith([emptyImageLayer(), adjustmentLayer({ type: "brightness_contrast" })])),
    ).toBeNull();
  });

  it("keeps odd pixel-layer invert stacks on the image executor", () => {
    const base = emptyImageLayer();
    base.layer = { kind: "pixel", edits: [{ type: "invert" }] };
    expect(compileImageAdjustments(docWith([base]))).toBeNull();
    // An even number of inverts cancels; disabled steps are skipped.
    base.layer = { kind: "pixel", edits: [{ type: "invert" }, { type: "invert" }] };
    expect(compileImageAdjustments(docWith([base]))?.layers).toHaveLength(0);
    base.layer = { kind: "pixel", edits: [{ type: "invert" }, { type: "invert", disabled: true }] };
    expect(compileImageAdjustments(docWith([base]))).toBeNull();
  });

  it("hidden pixel layers above the stack do not block compilation", () => {
    const grade = compileImageAdjustments(
      docWith([
        emptyImageLayer(),
        adjustmentLayer({ type: "levels", in_black: 10 }),
        { ...emptyImageLayer("Hidden"), visible: false },
      ]),
    );
    expect(grade?.layers).toHaveLength(1);
  });
});
