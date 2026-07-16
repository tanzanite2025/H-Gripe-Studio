//! Explicit execution-lane policy for the Studio run engine.
//!
//! Native image cards run on the bounded CPU lane, API-backed nodes use the
//! network lane, video encode has its own single slot, and compiled GPU kernels
//! use the shared GPU gate.

use std::sync::Arc;

use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

use super::graph::StudioGraphNode;
use super::node_registry::node_class;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobCategory {
    CpuLight,
    CpuBound,
    Gpu,
    VideoEncode,
    Network,
}

pub(crate) fn category_for_kind(kind: &str) -> Option<JobCategory> {
    node_class(kind).map(|class| class.category)
}

pub(crate) fn category_for_node(node: &StudioGraphNode) -> Option<JobCategory> {
    category_for_kind(node.kind.as_str())
}

pub(crate) fn concurrency_limit(category: JobCategory, cpu_pool: usize) -> usize {
    match category {
        JobCategory::CpuLight | JobCategory::Network => usize::MAX,
        JobCategory::CpuBound => cpu_pool.max(1),
        JobCategory::Gpu | JobCategory::VideoEncode => 1,
    }
}

fn default_cpu_pool() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .max(1)
}

pub(crate) const MAX_GPU_JOBS: usize = 4;

pub(crate) struct StudioScheduler {
    gpu: Arc<Semaphore>,
    gpu_limit: Mutex<usize>,
    video_encode: Arc<Semaphore>,
    cpu: Arc<Semaphore>,
    cpu_pool: usize,
}

impl StudioScheduler {
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

    pub(crate) fn cpu_pool(&self) -> usize {
        self.cpu_pool
    }

    pub(crate) async fn gpu_limit(&self) -> usize {
        *self.gpu_limit.lock().await
    }

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
            "subjectMask",
            "crop",
            "smartLayerSplit",
        ] {
            assert_eq!(category_for_kind(kind), Some(CpuBound), "{kind}");
        }
        assert_eq!(category_for_kind("videoAssemble"), Some(VideoEncode));
        assert_eq!(category_for_kind("videoTrim"), Some(VideoEncode));
        assert_eq!(category_for_kind("generate"), Some(Network));
        assert_eq!(category_for_kind("detailRepaint"), Some(Network));
        assert_eq!(category_for_kind("promptOptimize"), Some(Network));
        assert_eq!(category_for_kind("nope"), None);
    }

    #[test]
    fn gpu_and_video_are_single_slot() {
        assert_eq!(concurrency_limit(JobCategory::Gpu, 64), 1);
        assert_eq!(concurrency_limit(JobCategory::VideoEncode, 64), 1);
        assert_eq!(concurrency_limit(JobCategory::CpuBound, 8), 8);
        assert_eq!(concurrency_limit(JobCategory::CpuLight, 8), usize::MAX);
        assert_eq!(concurrency_limit(JobCategory::Network, 8), usize::MAX);
    }

    #[tokio::test]
    async fn lane_permits_are_independent() {
        let scheduler = StudioScheduler::with_cpu_pool(4);
        let gpu = scheduler.acquire(JobCategory::Gpu).await;
        assert!(gpu.is_some());
        assert!(scheduler.gpu.try_acquire().is_err());
        assert!(scheduler.acquire(JobCategory::CpuBound).await.is_some());
        let encode = scheduler.acquire(JobCategory::VideoEncode).await;
        assert!(encode.is_some());
        assert!(scheduler.video_encode.try_acquire().is_err());
    }

    #[tokio::test]
    async fn gpu_limit_resizes_and_clamps() {
        let scheduler = StudioScheduler::with_cpu_pool(4);
        assert_eq!(scheduler.set_gpu_limit(0).await, 1);
        assert_eq!(scheduler.set_gpu_limit(99).await, MAX_GPU_JOBS);
        assert_eq!(scheduler.gpu_limit().await, MAX_GPU_JOBS);
    }
}
