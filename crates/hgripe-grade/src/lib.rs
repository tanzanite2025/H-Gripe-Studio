// The standalone f32 colour-grading kernel. See docs/design/grade-kernel.md
// for the architecture: this crate owns compositing + grading maths only.
// ICC / colour management stay in the app's `studio/color` module; the kernel
// ingests and egresses plain 16-bit RGBA and works in f32 in between, so
// quantisation happens exactly once (at egress).
//
// Every observable behaviour is pinned by the shared golden vectors in
// `goldens/`, which the studio-ui preview mirror executes too — the two
// implementations are proven against the same JSON, not kept in sync by hand.

mod bake;
mod blend;
mod composite;
mod doc;
#[cfg(feature = "gpu")]
mod gpu;
mod ops;
mod qualifier;
mod scopes;
mod surface;
mod trc;

pub use bake::{bake_cube, CubeBake, MAX_CUBE_SIZE};
pub use blend::{blend_channel, blend_rgb, BlendMode};
pub use composite::composite_over;
#[cfg(feature = "parallel")]
pub use doc::apply_parallel;
pub use doc::{apply, GradeDoc, GradeLayer};
#[cfg(feature = "gpu")]
pub use gpu::{GpuError, GpuGrader};
pub use ops::{
    apply_op, parse_cube, temporal_denoise, ColorRange, CurveChannel, GradeOp, MonotoneSpline,
    RangeAdjust, WarpPoint, MAX_BLUR_SIGMA, MAX_RADIUS,
};
pub use qualifier::HslQualifier;
pub use scopes::{histogram, vectorscope, waveform, Histogram, Vectorscope, Waveform};
pub use surface::{GradeSpace, GradeSurface};
pub use trc::{trc_decode, trc_encode};
