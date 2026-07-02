// The standalone f32 colour-grading kernel. See docs/design/grade-kernel.md
// for the architecture: this crate owns compositing + grading maths only.
// ICC / colour management stay in the app's `studio/color` module; the kernel
// ingests and egresses plain 16-bit RGBA and works in f32 in between, so
// quantisation happens exactly once (at egress).
//
// Every observable behaviour is pinned by the shared golden vectors in
// `goldens/`, which the studio-ui preview mirror executes too — the two
// implementations are proven against the same JSON, not kept in sync by hand.

mod blend;
mod composite;
mod surface;

pub use blend::{blend_channel, BlendMode};
pub use composite::composite_over;
pub use surface::{GradeSpace, GradeSurface};
