//! Explicit execution-lane policy for the Studio run engine.
//!
//! `exec.rs` walks the topological order and `.await`s each node in turn, so
//! the GPU has historically been serialised *by accident* — nothing declared
//! that only one heavy job may touch the device at a time. This module makes
//! that policy **explicit** (see `docs/design/editor-resource-model.md`
//! § "Concurrency policy"): every node kind is classified into a
//! baseline [`JobCategory`], then parameter-visible ONNX requests are resolved
//! into conservative provider candidates. Only a candidate that the current
//! runtime resolver considers accelerated enters the GPU lane. This preflight is
//! advisory: graph nodes do not carry resolved inputs, model availability, or
//! session fallback state. The shared session resolution, its internal gate,
//! and per-stage reports remain the execution truth.
//!
//! This is the *skeleton* half of staged-rollout step 2: the run loop still
//! executes nodes sequentially, so acquiring a permit around a node does not
//! change results — it establishes the shared gate that a future parallel
//! scheduler (and the front-end preview lane) will contend on. Everything here
//! is deliberately pure / cheap so the classification is unit-testable without
//! standing up a GPU.

use std::sync::Arc;

use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

use super::graph::{studio_value_to_string, StudioGraphNode};
use super::node_registry::node_class;
use super::onnx_pool::{resolve_provider, OnnxDeviceRequest};

/// The resource lane a node's work runs in. Distinct from
/// [`StudioExecutor`](super::exec::StudioExecutor) (which decides *who* runs the
/// node — graph / python / native / broker):
/// this decides *what limited resource* the work contends for, which is what
/// the concurrency policy gates on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobCategory {
    /// In-process graph logic (routing, comparisons, passthroughs). Effectively
    /// free — never gated.
    CpuLight,
    /// CPU-bound native or `python/bridge` work (geometry, PSD, matting CLIs).
    /// May run in parallel up to a bounded pool.
    CpuBound,
    /// A conservative local-GPU candidate. This lane is scheduling advice, not
    /// proof that inference actually used an accelerator.
    Gpu,
    /// Video encode (assemble / trim through the vendored libav encoder).
    /// Serialised to one at a time — encoders are memory-heavy and an encode
    /// must not starve interactive work by fanning out — but on its own
    /// permit, so an export does not block model inference on the GPU gate.
    VideoEncode,
    /// A remote provider call through the broker. Bounded by the network / the
    /// provider, not the local GPU, so it does not take the GPU permit.
    Network,
}

/// Classify a node kind into its resource lane, or `None` for an unknown kind
/// (the single unsupported-kind gate). Delegates to the shared
/// [`node_registry`](super::node_registry) so the lane travels with the kind's
/// executor classification. Keep in sync with `nodeSpecs.ts`.
pub(crate) fn category_for_kind(kind: &str) -> Option<JobCategory> {
    node_class(kind).map(|class| class.category)
}

fn device_request_param(node: &StudioGraphNode) -> OnnxDeviceRequest {
    OnnxDeviceRequest::from_param(&studio_value_to_string(node.params.get("device")))
}

fn engine_param_is(node: &StudioGraphNode, expected: &str) -> bool {
    studio_value_to_string(node.params.get("engine"))
        .trim()
        .eq_ignore_ascii_case(expected)
}

/// Return the request a node may hand to ONNX inference, based only on params
/// visible before execution. This is deliberately conservative:
///
/// - `subjectMask` may receive `edit_paths.matte_strokes` through resolved
///   inputs, but [`StudioGraphNode`] contains params only. Its device request is
///   therefore always sent through candidate resolution, even for a manual mode.
/// - Crop auto-subject and Smart Layer Split call the shared segmenter with an
///   explicit CPU request, so their candidate is always CPU.
///
/// The returned request is not an actual provider resolution. Session creation
/// and per-stage reports own that truth.
fn onnx_candidate_request(node: &StudioGraphNode) -> Option<OnnxDeviceRequest> {
    match node.kind.as_str() {
        "matchLightColor" if engine_param_is(node, "onnx_harmonize") => {
            Some(device_request_param(node))
        }
        "refineMaskEdge" if engine_param_is(node, "onnx_matting") => {
            Some(device_request_param(node))
        }
        "detailWatchdog" if engine_param_is(node, "onnx_defect") => {
            Some(device_request_param(node))
        }
        "subjectMask" => Some(device_request_param(node)),
        "crop"
            if studio_value_to_string(node.params.get("mode"))
                .trim()
                .eq_ignore_ascii_case("auto_subject") =>
        {
            Some(OnnxDeviceRequest::Cpu)
        }
        "smartLayerSplit" => Some(OnnxDeviceRequest::Cpu),
        _ => None,
    }
}

fn resolved_candidate_category(base: JobCategory, accelerated_candidate: bool) -> JobCategory {
    if accelerated_candidate {
        JobCategory::Gpu
    } else {
        base
    }
}

/// Conservatively classify a concrete node from a pre-execution provider
/// candidate. `Gpu` means the current runtime resolver found an accelerated
/// candidate, not that the later session necessarily used it. The warm session's
/// provider resolution and per-stage report record actual use and fallback.
pub(crate) fn category_for_node(node: &StudioGraphNode) -> Option<JobCategory> {
    let base = category_for_kind(node.kind.as_str())?;
    let accelerated_candidate = onnx_candidate_request(node)
        .map(resolve_provider)
        .is_some_and(|resolution| resolution.accelerated());
    Some(resolved_candidate_category(base, accelerated_candidate))
}

/// The initial number of concurrent jobs allowed in a lane, given the CPU pool
/// size. `Gpu` starts at 1 but may be resized later; light and network work are
/// not locally gated.
pub(crate) fn concurrency_limit(category: JobCategory, cpu_pool: usize) -> usize {
    match category {
        JobCategory::CpuLight | JobCategory::Network => usize::MAX,
        JobCategory::CpuBound => cpu_pool.max(1),
        JobCategory::Gpu | JobCategory::VideoEncode => 1,
    }
}

/// The default CPU-pool size: the machine's parallelism, floored at 1.
fn default_cpu_pool() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .max(1)
}

/// Ceiling for the user-configurable GPU lane width (`set_gpu_limit`). Small
/// on purpose: the lane exists to keep the device responsive, not to fan out.
pub(crate) const MAX_GPU_JOBS: usize = 4;

/// Process-wide advisory gate for Studio compute lanes. The ONNX warm pool also
/// owns an independent, global single-slot accelerator gate that covers direct
/// commands and hidden editor paths. Its width is not changed by this scheduler.
pub(crate) struct StudioScheduler {
    gpu: Arc<Semaphore>,
    /// Current GPU lane width. Guards resizes so concurrent `set_gpu_limit`
    /// calls cannot double-count permits.
    gpu_limit: Mutex<usize>,
    video_encode: Arc<Semaphore>,
    cpu: Arc<Semaphore>,
    cpu_pool: usize,
}

impl StudioScheduler {
    /// Build a scheduler with a `Semaphore(1)` GPU gate and a CPU pool of the
    /// given size (floored at 1).
    pub(crate) fn with_cpu_pool(cpu_pool: usize) -> Self {
        let cpu_pool = cpu_pool.max(1);
        Self {
            gpu: Arc::new(Semaphore::new(concurrency_limit(
                JobCategory::Gpu,
                cpu_pool,
            ))),
            gpu_limit: Mutex::new(concurrency_limit(JobCategory::Gpu, cpu_pool)),
            video_encode: Arc::new(Semaphore::new(concurrency_limit(
                JobCategory::VideoEncode,
                cpu_pool,
            ))),
            cpu: Arc::new(Semaphore::new(cpu_pool)),
            cpu_pool,
        }
    }

    /// Configured CPU-pool size (the `CpuBound` concurrency limit).
    pub(crate) fn cpu_pool(&self) -> usize {
        self.cpu_pool
    }

    /// Current GPU lane width (permits the `Gpu` semaphore hands out).
    pub(crate) async fn gpu_limit(&self) -> usize {
        *self.gpu_limit.lock().await
    }

    /// Resize the GPU lane to `limit` jobs, clamped to `1..=MAX_GPU_JOBS`,
    /// and return the applied width. Growing adds permits immediately;
    /// shrinking waits for enough in-flight GPU jobs to finish, then retires
    /// their permits — running work is never interrupted.
    pub(crate) async fn set_gpu_limit(&self, limit: usize) -> usize {
        let limit = limit.clamp(1, MAX_GPU_JOBS);
        let mut current = self.gpu_limit.lock().await;
        if limit > *current {
            self.gpu.add_permits(limit - *current);
        } else if limit < *current {
            let retire = (*current - limit) as u32;
            if let Ok(permits) = self.gpu.clone().acquire_many_owned(retire).await {
                permits.forget();
            }
        }
        *current = limit;
        limit
    }

    /// Acquire a permit for a node's lane, holding it for the duration of the
    /// node's execution. `CpuLight` / `Network` are ungated and return `None`;
    /// `Gpu` and `CpuBound` return a permit that must be kept alive until the
    /// work finishes. The semaphores are never closed, so acquisition only
    /// fails if the runtime is torn down mid-await — treated as ungated.
    pub(crate) async fn acquire(&self, category: JobCategory) -> Option<OwnedSemaphorePermit> {
        let sem = match category {
            JobCategory::Gpu => &self.gpu,
            JobCategory::VideoEncode => &self.video_encode,
            JobCategory::CpuBound => &self.cpu,
            JobCategory::CpuLight | JobCategory::Network => return None,
        };
        sem.clone().acquire_owned().await.ok()
    }
}

/// Resize the advisory GPU lane (GPU_DEVICE_STRATEGY_PLAN long-term step 5,
/// "max concurrent GPU jobs"). Clamped to `1..=MAX_GPU_JOBS`; returns the
/// applied width so the settings surface can reflect the clamp. This does not
/// resize the ONNX warm pool's independent single-slot accelerator gate.
#[tauri::command]
pub(crate) async fn set_gpu_max_jobs(
    scheduler: tauri::State<'_, StudioScheduler>,
    limit: usize,
) -> Result<usize, String> {
    Ok(scheduler.set_gpu_limit(limit).await)
}

impl Default for StudioScheduler {
    fn default() -> Self {
        Self::with_cpu_pool(default_cpu_pool())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;

    fn node(kind: &str, params: &[(&str, Value)]) -> StudioGraphNode {
        StudioGraphNode {
            id: "n".to_string(),
            kind: kind.to_string(),
            params: params
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone()))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    #[test]
    fn category_mirrors_executor_split() {
        use JobCategory::*;
        for kind in ["number", "reroute", "if", "switch", "save"] {
            assert_eq!(category_for_kind(kind), Some(CpuLight), "{kind}");
        }
        for kind in [
            "psdContextAnalyze",
            "matchLightColor",
            "refineMaskEdge",
            "imageEnhance",
            "detailWatchdog",
            "psdExport",
        ] {
            assert_eq!(category_for_kind(kind), Some(CpuBound), "{kind}");
        }
        // Video encodes hold their own single-slot lane, not the GPU permit.
        assert_eq!(category_for_kind("videoAssemble"), Some(VideoEncode));
        assert_eq!(category_for_kind("videoTrim"), Some(VideoEncode));
        // Native compute starts from a CPU baseline; concrete-node scheduling
        // may promote an accelerated pre-execution ONNX candidate.
        assert_eq!(category_for_kind("subjectMask"), Some(CpuBound));
        assert_eq!(category_for_kind("crop"), Some(CpuBound));
        assert_eq!(category_for_kind("smartLayerSplit"), Some(CpuBound));
        // Broker / hybrid calls are network-bound, not GPU.
        assert_eq!(category_for_kind("generate"), Some(Network));
        assert_eq!(category_for_kind("detailRepaint"), Some(Network));
        assert_eq!(category_for_kind("promptOptimize"), Some(Network));
        // Unknown kinds stay unclassified (single gate, like the executor map).
        assert_eq!(category_for_kind("nope"), None);
    }

    #[test]
    fn onnx_candidate_requests_follow_each_nodes_parameter_path() {
        use JobCategory::CpuBound;
        use OnnxDeviceRequest::*;

        for (raw, expected) in [
            ("", Auto),
            ("cpu", Cpu),
            ("cuda", Cuda),
            ("directml", DirectMl),
            ("gpu", Gpu),
        ] {
            let candidate = node(
                "matchLightColor",
                &[("engine", json!("onnx_harmonize")), ("device", json!(raw))],
            );
            assert_eq!(onnx_candidate_request(&candidate), Some(expected), "{raw}");
            assert_eq!(category_for_node(&candidate), Some(CpuBound), "{raw}");
        }

        let refine = node(
            "refineMaskEdge",
            &[
                ("engine", json!("ONNX_MATTING")),
                ("device", json!("directml")),
            ],
        );
        assert_eq!(onnx_candidate_request(&refine), Some(DirectMl));
        assert_eq!(category_for_node(&refine), Some(CpuBound));

        let watchdog = node(
            "detailWatchdog",
            &[("engine", json!("onnx_defect")), ("device", json!("gpu"))],
        );
        assert_eq!(onnx_candidate_request(&watchdog), Some(Gpu));
        assert_eq!(category_for_node(&watchdog), Some(CpuBound));

        for (kind, engine) in [
            ("matchLightColor", "cpu"),
            ("refineMaskEdge", "cpu"),
            ("detailWatchdog", "rules"),
        ] {
            assert_eq!(
                onnx_candidate_request(&node(kind, &[("engine", json!(engine))])),
                None,
                "{kind}"
            );
        }
    }

    #[test]
    fn subject_mask_is_conservative_because_resolved_edit_paths_are_not_visible() {
        use JobCategory::CpuBound;
        use OnnxDeviceRequest::{Auto, Cpu, Cuda};

        let manual_default = node("subjectMask", &[("mode", json!("manual_brush"))]);
        assert_eq!(onnx_candidate_request(&manual_default), Some(Auto));
        assert_eq!(category_for_node(&manual_default), Some(CpuBound));

        let manual_cuda = node(
            "subjectMask",
            &[
                ("mode", json!("manual_brush")),
                ("alpha_matting", json!(false)),
                ("device", json!("cuda")),
            ],
        );
        assert_eq!(onnx_candidate_request(&manual_cuda), Some(Cuda));
        assert_eq!(category_for_node(&manual_cuda), Some(CpuBound));

        let manual_cpu = node(
            "subjectMask",
            &[
                ("mode", json!("manual_brush")),
                ("alpha_matting", json!(false)),
                ("device", json!("cpu")),
            ],
        );
        assert_eq!(onnx_candidate_request(&manual_cpu), Some(Cpu));
        assert_eq!(category_for_node(&manual_cpu), Some(CpuBound));
    }

    #[test]
    fn fixed_cpu_and_non_onnx_paths_keep_the_cpu_baseline() {
        use JobCategory::CpuBound;
        use OnnxDeviceRequest::Cpu;

        let auto_crop = node("crop", &[("mode", json!("auto_subject"))]);
        assert_eq!(onnx_candidate_request(&auto_crop), Some(Cpu));
        assert_eq!(category_for_node(&auto_crop), Some(CpuBound));

        let manual_crop = node("crop", &[("mode", json!("manual"))]);
        assert_eq!(onnx_candidate_request(&manual_crop), None);
        assert_eq!(category_for_node(&manual_crop), Some(CpuBound));

        let split = node("smartLayerSplit", &[]);
        assert_eq!(onnx_candidate_request(&split), Some(Cpu));
        assert_eq!(category_for_node(&split), Some(CpuBound));
        assert_eq!(onnx_candidate_request(&node("imageEnhance", &[])), None);
    }

    #[test]
    fn resolved_candidate_category_promotes_only_an_accelerated_candidate() {
        use JobCategory::{CpuBound, Gpu};

        assert_eq!(resolved_candidate_category(CpuBound, true), Gpu);
        assert_eq!(resolved_candidate_category(CpuBound, false), CpuBound);
    }

    #[test]
    fn gpu_is_single_slot_regardless_of_pool() {
        assert_eq!(concurrency_limit(JobCategory::Gpu, 1), 1);
        assert_eq!(concurrency_limit(JobCategory::Gpu, 64), 1);
        assert_eq!(concurrency_limit(JobCategory::VideoEncode, 64), 1);
        assert_eq!(concurrency_limit(JobCategory::CpuBound, 8), 8);
        assert_eq!(concurrency_limit(JobCategory::CpuBound, 0), 1);
        assert_eq!(concurrency_limit(JobCategory::CpuLight, 8), usize::MAX);
        assert_eq!(concurrency_limit(JobCategory::Network, 8), usize::MAX);
    }

    #[test]
    fn scheduler_floors_cpu_pool_at_one() {
        let scheduler = StudioScheduler::with_cpu_pool(0);
        assert_eq!(scheduler.cpu_pool(), 1);
    }

    #[tokio::test]
    async fn gpu_permit_serialises_and_releases() {
        let scheduler = StudioScheduler::with_cpu_pool(4);
        // Light / network lanes are never gated.
        assert!(scheduler.acquire(JobCategory::CpuLight).await.is_none());
        assert!(scheduler.acquire(JobCategory::Network).await.is_none());

        // Only one GPU permit exists; while it's held the gate is exhausted.
        let permit = scheduler.acquire(JobCategory::Gpu).await;
        assert!(permit.is_some());
        assert!(
            scheduler.gpu.try_acquire().is_err(),
            "a second GPU permit must not be available while one is held"
        );
        // CPU-bound work still flows in parallel with the held GPU permit,
        // and a video encode holds its own lane rather than the GPU gate.
        assert!(scheduler.acquire(JobCategory::CpuBound).await.is_some());
        let encode = scheduler.acquire(JobCategory::VideoEncode).await;
        assert!(encode.is_some());
        assert!(
            scheduler.video_encode.try_acquire().is_err(),
            "a second encode permit must not be available while one is held"
        );
        drop(encode);

        // Dropping the permit frees the single GPU slot again.
        drop(permit);
        assert!(scheduler.gpu.try_acquire().is_ok());
    }

    #[tokio::test]
    async fn gpu_limit_resizes_and_clamps() {
        let scheduler = StudioScheduler::with_cpu_pool(4);
        assert_eq!(scheduler.gpu_limit().await, 1);

        // Out-of-range requests clamp instead of failing.
        assert_eq!(scheduler.set_gpu_limit(0).await, 1);
        assert_eq!(scheduler.set_gpu_limit(99).await, MAX_GPU_JOBS);
        assert_eq!(scheduler.gpu_limit().await, MAX_GPU_JOBS);

        // Widening added permits: two jobs fit at width 2, a third does not.
        assert_eq!(scheduler.set_gpu_limit(2).await, 2);
        let a = scheduler.acquire(JobCategory::Gpu).await;
        let b = scheduler.acquire(JobCategory::Gpu).await;
        assert!(a.is_some() && b.is_some());
        assert!(scheduler.gpu.try_acquire().is_err());

        // Shrinking back to one retires the extra permit once released:
        // only a single slot remains.
        drop(a);
        drop(b);
        assert_eq!(scheduler.set_gpu_limit(1).await, 1);
        let only = scheduler.gpu.try_acquire();
        assert!(only.is_ok());
        assert!(scheduler.gpu.try_acquire().is_err());
    }
}
