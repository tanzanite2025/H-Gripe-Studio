//! RGB colour management for the studio pipeline: the 16-bit `WorkingImage`
//! surface, sRGB/ProPhoto conversion, linear-light helpers, and the 8-bit sRGB
//! egress consumed by screen previews and API boundaries.

pub(crate) mod linear;
pub(crate) mod working_image;
