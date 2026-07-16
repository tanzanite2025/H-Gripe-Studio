//! Candidate-neutral, metadata-only camera RAW probing.
//!
//! R0-A deliberately stops before pixel decode and product loader integration.

mod error;
mod model;
mod tiff;

pub use error::RawProbeError;
pub use model::*;
pub use tiff::probe_dng;
