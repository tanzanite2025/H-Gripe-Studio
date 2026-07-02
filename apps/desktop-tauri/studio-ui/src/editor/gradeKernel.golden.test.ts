// The TS half of the dual-end golden contract: run the exact same vectors
// as `cargo test -p hgripe-grade` (crates/hgripe-grade/goldens/) against the
// preview mirror. New golden files must be imported here (the Rust runner
// globs the directory; this side lists them explicitly so tsc can resolve
// the JSON). See docs/design/grade-kernel.md.

import { describe, expect, it } from "vitest";
import blendSeparable from "../../../../../crates/hgripe-grade/goldens/blend_separable.json";
import opsCore from "../../../../../crates/hgripe-grade/goldens/ops_core.json";
import opsHdr from "../../../../../crates/hgripe-grade/goldens/ops_hdr.json";
import opsPro from "../../../../../crates/hgripe-grade/goldens/ops_pro.json";
import opsVideo from "../../../../../crates/hgripe-grade/goldens/ops_video.json";
import {
  applyDoc,
  compositeOver,
  type GradeBlendMode,
  type GradeDoc,
  type GradeSpace,
  type GradeSurface,
} from "./gradeKernel";

interface GoldenSurface {
  w: number;
  h: number;
  space: string;
  data: number[];
}

interface CompositeCase {
  name: string;
  mode: string;
  opacity: number;
  mask: number[] | null;
  backdrop: GoldenSurface;
  source: GoldenSurface;
  expected: number[];
  tolerance: number;
}

interface DocCase {
  name: string;
  doc: unknown;
  input: GoldenSurface;
  expected: number[];
  tolerance: number;
}

const surface = (g: GoldenSurface): GradeSurface => ({
  w: g.w,
  h: g.h,
  data: Float32Array.from(g.data),
  space: g.space as GradeSpace,
});

function assertClose(got: Float32Array, want: number[], tolerance: number) {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(Math.abs(got[i] - want[i]), `sample ${i}`).toBeLessThanOrEqual(tolerance);
  }
}

describe("grade kernel golden vectors (shared with Rust)", () => {
  for (const c of (blendSeparable as { cases: CompositeCase[] }).cases) {
    it(`blend_separable.json: ${c.name}`, () => {
      const dst = surface(c.backdrop);
      compositeOver(
        dst,
        surface(c.source),
        c.mode as GradeBlendMode,
        c.opacity,
        c.mask ? Float32Array.from(c.mask) : null,
      );
      assertClose(dst.data, c.expected, c.tolerance);
    });
  }

  for (const [file, json] of [
    ["ops_core.json", opsCore],
    ["ops_video.json", opsVideo],
    ["ops_pro.json", opsPro],
    ["ops_hdr.json", opsHdr],
  ] as const) {
    for (const c of (json as { cases: DocCase[] }).cases) {
      it(`${file}: ${c.name}`, () => {
        const dst = surface(c.input);
        applyDoc(c.doc as GradeDoc, dst);
        assertClose(dst.data, c.expected, c.tolerance);
      });
    }
  }
});
