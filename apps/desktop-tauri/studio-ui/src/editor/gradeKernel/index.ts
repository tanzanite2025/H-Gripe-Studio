// Preview mirror of the Rust grade kernel (`crates/hgripe-grade`). Pure f32
// blend + compositing maths, no DOM. This is NOT kept in sync by comment
// discipline: both implementations are pinned to the same golden vectors in
// `crates/hgripe-grade/goldens/`, executed here by `gradeKernel.golden.test.ts`
// and in Rust by `cargo test -p hgripe-grade`. See docs/design/grade-kernel.md.
//
// Modules mirror the Rust crate layout: `types` (surface + shared maths),
// `blend` (blend.rs), `trc` (trc.rs), `spline`/`hsl`/`lut`/`wb`/`spatial`
// (ops/*.rs), `ops` (ops/mod.rs), `doc` (doc.rs + qualifier.rs +
// composite.rs), `scopes` (scopes.rs).

export { blendChannel, blendRgb } from "./blend";
export {
  applyDoc,
  compositeOver,
  qualifierGate,
  type GradeDoc,
  type GradeLayer,
  type HslQualifier,
} from "./doc";
export { parseCube } from "./lut";
export { applyOp, isSpatialOp, type CurveChannel, type GradeOp, type WarpPoint } from "./ops";
export {
  histogramScope,
  vectorscopeScope,
  waveformScope,
  type HistogramScope,
  type VectorscopeScope,
  type WaveformScope,
} from "./scopes";
export { denoise, filmGrain, sharpen, temporalDenoise, MAX_RADIUS } from "./spatial";
export { monotoneSpline } from "./spline";
export { trcDecode, trcEncode } from "./trc";
export { BLEND_MODES, type GradeBlendMode, type GradeSpace, type GradeSurface } from "./types";
export { planckianGains } from "./wb";
