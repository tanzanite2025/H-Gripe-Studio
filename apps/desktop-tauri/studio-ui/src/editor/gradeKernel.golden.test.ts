// The TS half of the dual-end golden contract: run the exact same vectors
// as `cargo test -p hgripe-grade` (crates/hgripe-grade/goldens/) against the
// preview mirror. New golden files must be imported here (the Rust runner
// globs the directory; this side lists them explicitly so tsc can resolve
// the JSON). See docs/design/grade-kernel.md.

import { describe, expect, it } from "vitest";
import blendSeparable from "../../../../../crates/hgripe-grade/goldens/blend_separable.json";
import opsBlurVignette from "../../../../../crates/hgripe-grade/goldens/ops_blur_vignette.json";
import opsCore from "../../../../../crates/hgripe-grade/goldens/ops_core.json";
import opsHdr from "../../../../../crates/hgripe-grade/goldens/ops_hdr.json";
import opsLut1d from "../../../../../crates/hgripe-grade/goldens/ops_lut1d.json";
import opsMixer from "../../../../../crates/hgripe-grade/goldens/ops_mixer.json";
import opsPro from "../../../../../crates/hgripe-grade/goldens/ops_pro.json";
import opsSpatial from "../../../../../crates/hgripe-grade/goldens/ops_spatial.json";
import opsVideo from "../../../../../crates/hgripe-grade/goldens/ops_video.json";
import opsWarper from "../../../../../crates/hgripe-grade/goldens/ops_warper.json";
import scopes from "../../../../../crates/hgripe-grade/goldens/scopes.json";
import temporalDenoiseGoldens from "../../../../../crates/hgripe-grade/goldens/temporal_denoise.json";
import {
  applyDoc,
  compositeOver,
  histogramScope,
  temporalDenoise,
  vectorscopeScope,
  waveformScope,
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

interface TemporalCase {
  name: string;
  amount: number;
  prev: GoldenSurface;
  input: GoldenSurface;
  expected: number[];
  tolerance: number;
}

interface ScopeCase {
  name: string;
  scope:
    | { type: "histogram"; bins: number }
    | { type: "waveform"; cols: number; rows: number }
    | { type: "vectorscope"; size: number };
  input: GoldenSurface;
  expected: Record<string, number | number[] | undefined>;
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
    ["ops_mixer.json", opsMixer],
    ["ops_lut1d.json", opsLut1d],
    ["ops_warper.json", opsWarper],
    ["ops_spatial.json", opsSpatial],
    ["ops_blur_vignette.json", opsBlurVignette],
  ] as const) {
    for (const c of (json as { cases: DocCase[] }).cases) {
      it(`${file}: ${c.name}`, () => {
        const dst = surface(c.input);
        applyDoc(c.doc as GradeDoc, dst);
        assertClose(dst.data, c.expected, c.tolerance);
      });
    }
  }

  for (const c of (temporalDenoiseGoldens as { cases: TemporalCase[] }).cases) {
    it(`temporal_denoise.json: ${c.name}`, () => {
      const dst = surface(c.input);
      temporalDenoise(dst, surface(c.prev), c.amount);
      assertClose(dst.data, c.expected, c.tolerance);
    });
  }

  // Scope counts are integers and the maths is f64 on both ends: exact.
  for (const c of (scopes as { cases: ScopeCase[] }).cases) {
    it(`scopes.json: ${c.name}`, () => {
      const input = surface(c.input);
      const got =
        c.scope.type === "histogram"
          ? histogramScope(input, c.scope.bins)
          : c.scope.type === "waveform"
            ? waveformScope(input, c.scope.cols, c.scope.rows)
            : vectorscopeScope(input, c.scope.size);
      for (const [key, want] of Object.entries(c.expected)) {
        const val = (got as unknown as Record<string, number | Uint32Array>)[key];
        if (typeof want === "number") expect(val).toBe(want);
        else if (want) expect(Array.from(val as Uint32Array)).toEqual(want);
      }
    });
  }
});
