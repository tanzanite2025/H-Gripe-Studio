// The TS half of the dual-end golden contract: run the exact same vectors
// as `cargo test -p hgripe-grade` (crates/hgripe-grade/goldens/) against the
// preview mirror. New golden files must be imported here (the Rust runner
// globs the directory; this side lists them explicitly so tsc can resolve
// the JSON). See docs/design/grade-kernel.md.

import { describe, expect, it } from "vitest";
import blendSeparable from "../../../../../crates/hgripe-grade/goldens/blend_separable.json";
import { compositeOver, type GradeBlendMode, type GradeSpace, type GradeSurface } from "./gradeKernel";

interface GoldenSurface {
  w: number;
  h: number;
  space: string;
  data: number[];
}

interface GoldenCase {
  name: string;
  mode: string;
  opacity: number;
  mask: number[] | null;
  backdrop: GoldenSurface;
  source: GoldenSurface;
  expected: number[];
  tolerance: number;
}

const GOLDEN_FILES: Record<string, { cases: GoldenCase[] }> = {
  "blend_separable.json": blendSeparable,
};

const surface = (g: GoldenSurface): GradeSurface => ({
  w: g.w,
  h: g.h,
  data: Float32Array.from(g.data),
  space: g.space as GradeSpace,
});

describe("grade kernel golden vectors (shared with Rust)", () => {
  for (const [file, { cases }] of Object.entries(GOLDEN_FILES)) {
    for (const c of cases) {
      it(`${file}: ${c.name}`, () => {
        const dst = surface(c.backdrop);
        compositeOver(
          dst,
          surface(c.source),
          c.mode as GradeBlendMode,
          c.opacity,
          c.mask ? Float32Array.from(c.mask) : null,
        );
        expect(dst.data.length).toBe(c.expected.length);
        for (let i = 0; i < c.expected.length; i++) {
          expect(Math.abs(dst.data[i] - c.expected[i]), `sample ${i}`).toBeLessThanOrEqual(c.tolerance);
        }
      });
    }
  }
});
