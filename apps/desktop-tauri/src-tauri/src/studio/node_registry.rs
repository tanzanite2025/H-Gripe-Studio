//! The single source of truth mapping a Studio node `kind` to its execution
//! class: which [`StudioExecutor`] runs it and which baseline [`JobCategory`]
//! resource lane its work contends on.
//!
//! Both [`super::exec::studio_executor_for_kind`] and
//! [`super::schedule::category_for_kind`] delegate here, so onboarding a new
//! node kind is a single row edit rather than keeping two parallel `match kind`
//! tables in step. Parameter-dependent ONNX nodes may be conservatively promoted
//! from the baseline CPU lane by `schedule::category_for_node` when pre-execution
//! resolution finds an accelerated provider candidate. That candidate is
//! advisory; the shared session resolution and per-stage report are
//! authoritative. An unknown kind
//! returns `None` — the single gate for unsupported kinds. Keep in sync with
//! `nodeSpecs.ts`.
//!
//! Note this classifies *what resources* a kind is allowed to touch; it does
//! **not** dispatch to the executor function. That dispatch stays in `exec`'s
//! per-lane handlers (`execute_studio_{graph,local,compute,api}_node`), each of
//! which is handed only the resources its lane may use, so the local / native /
//! broker boundary remains enforced structurally rather than by a lookup table.

use super::exec::StudioExecutor;
use super::schedule::JobCategory;

/// The execution class of a node kind: the executor that runs it paired with
/// the resource lane it is scheduled on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NodeClass {
    pub(crate) executor: StudioExecutor,
    pub(crate) category: JobCategory,
}

/// Classify a node kind, or `None` when the kind is unsupported.
pub(crate) fn node_class(kind: &str) -> Option<NodeClass> {
    use JobCategory::*;
    use StudioExecutor::*;
    // Pure in-process graph logic: routing, comparisons, sources, sinks.
    let (executor, category) = match kind {
        "batch" | "imageSource" | "videoSource" | "psdTemplate" | "number" | "reroute"
        | "group" | "compare" | "logic" | "if" | "switch" | "save" => (Graph, CpuLight),
        // Local native cards. Their baseline/fallback work is CPU-bound;
        // conservative scheduling may promote an accelerated ONNX candidate.
        "psdContextAnalyze" | "matchLightColor" | "refineMaskEdge" | "imageEnhance"
        | "detailWatchdog" | "psdExport" => (Local, CpuBound),
        // Video encodes (vendored libav encoder) hold their own single-slot
        // lane: serialised against each other, but not against the GPU gate.
        "videoAssemble" | "videoTrim" => (Local, VideoEncode),
        // Native-Rust compute cards use the CPU baseline. `category_for_node`
        // always resolves a Subject Mask provider candidate because resolved
        // edit-path inputs are not visible here; current CPU plans stay CPU.
        "subjectMask" => (Compute, CpuBound),
        "crop" => (Compute, CpuBound),
        // The layer-split node runs the subject segmentation stack in-process
        // (model backend when a weight resolves, else the builtin CPU
        // segmenter) and writes per-layer artifacts: CPU-bound compute.
        "smartLayerSplit" => (Compute, CpuBound),
        // The grading kernel node: CPU row-parallel by default; the optional
        // `grade-gpu` build routes through wgpu inside the same lane.
        "imageGrade" => (Compute, CpuBound),
        // Broker / hybrid calls await a (possibly remote) provider; they are
        // network-bound and never hold the local GPU permit.
        "generate" | "detailRepaint" => (Api, Network),
        "promptOptimize" => (Hybrid, Network),
        _ => return None,
    };
    Some(NodeClass { executor, category })
}
