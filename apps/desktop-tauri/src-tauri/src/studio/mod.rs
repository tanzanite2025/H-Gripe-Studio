//! Studio graph editor backend, split into focused submodules:
//! - [`color`]: colour management along the pixel's journey — CMYK ingress
//!   (`cmyk_decode`), colour-managed transforms (`cmyk_transform`), and the
//!   16-bit working surface / sRGB egress (`working_image`). All moxcms
//!   transforms are constructed inside this submodule.
//! - [`graph`]: the workflow graph schema + shared value-coercion helpers.
//! - [`exec`]: the topological execution engine and lane dispatch.
//! - [`run_events`]: run-event emission, structured node error details, and
//!   the node-scoped run logger.
//! - [`run_cancel`]: per-run cancellation token state.
//! - [`api_call`]: shared broker-call plumbing for API-lane executors
//!   (cancellable execute + task history, task ids, numeric param readers).
//! - [`write_skip`]: PNG write-skip analysis for compute-node outputs.
//! - [`generate`]: the `generate` node executor (provider image call).
//! - [`grade`]: the `imageGrade` node executor and the grading dialog's
//!   `grade_preview` command (the `hgripe-grade` kernel's UI entry points).
//! - [`detail_repaint`]: the `detailRepaint` node executor (issue-region
//!   repaint via provider `image.edit`).
//! - [`prompt_optimize`]: the `promptOptimize` node executor (local
//!   normalise/dedupe pass or provider `text.generate`).
//! - [`node_registry`]: single source of truth mapping a node `kind` to its
//!   executor + resource lane (`studio_executor_for_kind` / `category_for_kind`).
//! - [`psd_analyze`]: the `psdContextAnalyze` node executor (PSD context bridge).
//! - [`color_match`]: the `matchLightColor` node executor (light/colour match).
//! - [`edge_refine`]: the `refineMaskEdge` node executor (mask edge refine).
//! - [`image_enhance`]: the `imageEnhance` node executor (in-process native
//!   `cpu` engine).
//! - [`image_enhance_cpu`]: native-Rust replica of the CLI's `--engine cpu`
//!   pipeline, run in-process for common 8-bit inputs.
//! - [`detail_watchdog`]: the `detailWatchdog` node executor (CPU quality scan).
//! - [`psd_export`]: the `psdExport` node executor (PSD composition bridge).
//! - [`studio_image`]: decode-guard + colour-space loaders shared by native
//!   (`Compute`) Rust cards.
//! - [`pixel_ops`]: unified crop/resize buffer seam shared by native Rust cards.
//! - [`image_buffer`]: process-global decoded-buffer cache (keyed by
//!   `ResourceId`) so a compute card's output feeds the next one from memory
//!   instead of a PNG re-decode.
//! - [`media_index`]: persistent index/cache of node results so an unchanged
//!   node is served from the previous run's media instead of re-executing.
//! - [`subject_mask`]: the `subjectMask` node executor (native-Rust matte).
//! - [`subject_matte`]: continuous alpha matting (ViTMatte / trimap, Compute lane).
//! - [`subject_sam2`]: SAM 2 interactive point-prompt segmenter (Compute lane).
//! - [`reflection_regions`]: heuristic reflection candidate detection for
//!   `smartLayerSplit` (Phase 3).
//! - [`shadow_regions`]: heuristic cast-shadow candidate detection for
//!   `smartLayerSplit` (Phase 3).
//! - [`text_regions`]: heuristic text region detection for `smartLayerSplit`
//!   (Phase 3 protected text-layer candidates).
//! - [`video_assemble`]: the `videoAssemble` node executor (native FFmpeg
//!   frame-sequence -> video encode).
//! - [`video_trim`]: the `videoTrim` node executor (frame-accurate cut of a
//!   time range via the native FFmpeg path).
//! - [`persist`]: on-disk autosave, workflow files, recents, and pickers.
//! - [`history`]: project-scoped snapshot / run-history JSON stores.
//!
//! The Tauri commands keep their original `crate::studio::*` paths via the
//! re-exports below, so `main.rs`'s `invoke_handler` registration is unchanged.

mod api_call;
mod audio_mix;
mod color;
mod color_match;
pub(crate) mod color_match_cpu;
mod crop;
mod detail_repaint;
pub(crate) mod detail_repaint_cpu;
mod detail_watchdog;
pub(crate) mod detail_watchdog_cpu;
mod device_report;
mod edge_refine;
pub(crate) mod edge_refine_cpu;
mod exec;
#[cfg(feature = "native-ffmpeg")]
mod ffmpeg_native;
mod frame_cache;
mod generate;
pub(crate) mod grade;
mod graph;
pub(crate) mod heif_decode;
mod history;
pub(crate) mod image_buffer;
mod image_enhance;
pub(crate) mod image_enhance_cpu;
mod layer_merge;
mod layer_split;
mod media_index;
mod node_registry;
mod onnx_pool;
mod persist;
mod pixel_ops;
mod prompt_optimize;
mod psd_analyze;
mod psd_export;
mod reflection_regions;
mod run_cancel;
mod run_events;
mod schedule;
mod shadow_regions;
pub(crate) mod studio_image;
mod subject_mask;
mod subject_matte;
mod subject_model;
mod subject_sam2;
mod subject_segment;
mod text_regions;
mod timeline_export;
mod video_assemble;
pub(crate) mod video_engine;
mod video_trim;
pub(crate) mod wgpu_device;
mod write_skip;

// The colour layers keep their original `crate::studio::<layer>` paths so the
// many call sites (and their docs) stay stable while the files live together
// under `color/`.
pub(crate) use color::{cmyk_decode, cmyk_transform, linear, working_image};

// Glob re-exports so the original `crate::studio::*` command paths keep
// resolving from `main.rs`'s `generate_handler!`. A plain `use exec::cmd` only
// re-exports the function, not the hidden `__cmd__cmd` helper that the Tauri
// command macro generates beside it; the glob carries both.
pub(crate) use exec::*;
pub(crate) use grade::*;
pub(crate) use history::*;
pub(crate) use layer_merge::*;
pub(crate) use media_index::*;
pub(crate) use persist::*;
pub(crate) use schedule::StudioScheduler;
pub(crate) use subject_model::set_resource_dir as set_subject_model_resource_dir;
pub(crate) use timeline_export::*;
