//! The `imageGrade` node executor (the `Compute` lane, in-process native Rust)
//! and the grading dialog's `grade_preview` Tauri command.
//!
//! Both run the `hgripe-grade` kernel (`crates/hgripe-grade`) over a
//! [`GradeDoc`] op graph authored in the editor's grading dialog:
//!
//! * **`grade_preview`** — the dialog's live preview: decode + downscale to a
//!   preview surface, run the document, return a PNG data URL. Runs the GPU
//!   backend when the `grade-gpu` feature is compiled in and an adapter is
//!   available, otherwise the CPU reference path (row-parallel via rayon).
//! * **`execute_studio_grade`** — the node's run path: the full-resolution
//!   16-bit canonical surface walks through the kernel in its working space
//!   (sRGB or ProPhoto), so a wide-gamut input is graded and re-emitted at
//!   full precision with its ICC intact.
//!
//! [`TemporalAccumulator`] is the previous-frame hook reserved for the video
//! grading dialog (`temporal_denoise` needs the prior graded frame).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use image::RgbaImage;
use serde::Serialize;
use serde_json::{json, Value};

use hgripe_grade::{GradeDoc, GradeSpace, GradeSurface};

use super::graph::{
    number_param, optional, studio_output_map, studio_value_to_string, StudioGraphNode,
};
use super::image_buffer;
use super::persist::studio_reject_unsafe_basename;
use super::studio_image;
use super::working_image::{WorkingImage, WorkingSpace};

/// Map the app's working-space tag onto the kernel's (the kernel never sees
/// an ICC profile — only the TRC/primaries tag; see `grade-kernel.md`).
pub(super) fn grade_space(space: WorkingSpace) -> GradeSpace {
    match space {
        WorkingSpace::Srgb => GradeSpace::Srgb,
        WorkingSpace::ProPhoto => GradeSpace::ProPhoto,
    }
}

/// The backend that ran a grade, plus why the GPU path did not run when it
/// fell back — fallback is a reportable runtime decision, not a failure
/// (GPU_DEVICE_STRATEGY_PLAN fallback contract).
#[derive(Debug, Clone)]
pub(crate) struct GradeBackend {
    pub(crate) name: &'static str,
    pub(crate) fallback_reason: Option<String>,
}

impl GradeBackend {
    fn gpu() -> Self {
        Self {
            name: "gpu",
            fallback_reason: None,
        }
    }

    fn cpu(reason: String) -> Self {
        Self {
            name: "cpu",
            fallback_reason: Some(reason),
        }
    }
}

/// The one process-wide GPU grader: adapter/device setup is expensive and the
/// compiled pipelines are cached inside it, keyed by the op sequence. A failed
/// init is cached too, so its reason stays reportable.
#[cfg(feature = "grade-gpu")]
fn gpu_grader() -> &'static Result<std::sync::Mutex<hgripe_grade::GpuGrader>, String> {
    use std::sync::{Mutex, OnceLock};
    static GRADER: OnceLock<Result<Mutex<hgripe_grade::GpuGrader>, String>> = OnceLock::new();
    GRADER.get_or_init(|| {
        hgripe_grade::GpuGrader::new()
            .map(Mutex::new)
            .map_err(|err| err.to_string())
    })
}

/// Probe the grade kernel's wgpu adapter for the capability summary:
/// `Ok(adapter summary)` when the shared grader initialised, `Err(reason)`
/// when it could not (or the `grade-gpu` feature is disabled). Initialises
/// the process-wide grader on first call; the result is cached either way.
pub(crate) fn wgpu_capability() -> Result<String, String> {
    #[cfg(feature = "grade-gpu")]
    {
        match gpu_grader() {
            Ok(grader) => match grader.lock() {
                Ok(grader) => Ok(grader.adapter_summary().to_string()),
                Err(_) => Err("GPU grader unavailable: lock poisoned".to_string()),
            },
            Err(err) => Err(format!("GPU unavailable: {err}")),
        }
    }
    #[cfg(not(feature = "grade-gpu"))]
    {
        Err("GPU backend not compiled in (grade-gpu feature disabled)".to_string())
    }
}

/// Run a grade document over a surface, preferring the GPU backend when it is
/// compiled in (`grade-gpu`) and an adapter initialises; the CPU reference
/// path (rayon row-parallel) is the fallback. Returns the backend used and,
/// on CPU fallback, the reason the GPU path did not run.
pub(crate) fn apply_grade_doc(doc: &GradeDoc, surface: &mut GradeSurface) -> GradeBackend {
    #[cfg(feature = "grade-gpu")]
    let reason: String = {
        match gpu_grader() {
            Ok(grader) => match grader.lock() {
                Ok(mut grader) => match grader.apply(doc, surface) {
                    Ok(()) => return GradeBackend::gpu(),
                    Err(err) => format!("GPU grade failed: {err}"),
                },
                Err(_) => "GPU grader unavailable: lock poisoned".to_string(),
            },
            Err(err) => format!("GPU unavailable: {err}"),
        }
    };
    #[cfg(not(feature = "grade-gpu"))]
    let reason = "GPU backend not compiled in (grade-gpu feature disabled)".to_string();
    hgripe_grade::apply_parallel(doc, surface);
    GradeBackend::cpu(reason)
}

/// Parse a `grade_doc` value: either the document object itself or a JSON
/// string holding one. Missing / empty reads as the identity document.
pub(crate) fn parse_grade_doc(value: Option<&Value>) -> Result<GradeDoc, String> {
    match value {
        None | Some(Value::Null) => Ok(GradeDoc { layers: vec![] }),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(GradeDoc { layers: vec![] }),
        Some(Value::String(s)) => serde_json::from_str(s)
            .map_err(|err| format!("grade_doc is not a valid grade document: {err}")),
        Some(other) => serde_json::from_value(other.clone())
            .map_err(|err| format!("grade_doc is not a valid grade document: {err}")),
    }
}

fn param_or(node: &StudioGraphNode, key: &str, default: &str) -> String {
    match optional(studio_value_to_string(node.params.get(key))) {
        Some(value) => value,
        None => default.to_string(),
    }
}

fn image_stem(path: &str) -> String {
    Path::new(path.trim())
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string())
}

/// The flat enriched report mirrored onto the `grade_report` output port.
#[derive(Debug, Serialize)]
struct GradeReport {
    backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend_fallback_reason: Option<String>,
    layers: usize,
    ops: usize,
    op_types: Vec<String>,
    source_mode: String,
    working_space: String,
    input_size: [u32; 2],
    max_decode_pixels: u64,
    processing_time_ms: u128,
}

// The serde tag of an op (`{"type": "exposure", ...}`), for the report.
fn op_type_tag(op: &hgripe_grade::GradeOp) -> String {
    serde_json::to_value(op)
        .ok()
        .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

pub(super) fn execute_studio_grade(
    node: &StudioGraphNode,
    inputs: &BTreeMap<String, Value>,
    skip_write_ports: &std::collections::HashSet<String>,
) -> Result<BTreeMap<String, Value>, String> {
    let started = Instant::now();

    let image_path = studio_value_to_string(inputs.get("image"));
    if image_path.trim().is_empty() {
        return Err("Grade needs a connected image input".to_string());
    }
    let doc = parse_grade_doc(node.params.get("grade_doc"))?;

    let max_decode_pixels = {
        let configured = number_param(node, "max_decode_pixels", -1.0);
        if configured < 0.0 {
            studio_image::DEFAULT_MAX_DECODE_PIXELS
        } else {
            configured as u64
        }
    };

    // Grading walks the 16-bit canonical surface in its own working space —
    // the kernel quantises exactly once (at egress back to u16), so a
    // wide-gamut input stays wide-gamut with its ICC travelling alongside.
    let loaded = studio_image::load_working(Path::new(image_path.trim()), max_decode_pixels)?;
    let image = loaded.image;
    let (width, height) = (image.width, image.height);
    if width == 0 || height == 0 {
        return Err("Grade needs a non-empty image".to_string());
    }

    let mut surface =
        GradeSurface::from_rgba16(width, height, &image.pixels, grade_space(image.space));
    let backend = apply_grade_doc(&doc, &mut surface);
    let graded = WorkingImage {
        width,
        height,
        pixels: surface.to_rgba16(),
        space: image.space,
        icc: image.icc.clone(),
    };

    let output_dir = {
        let configured = studio_value_to_string(node.params.get("output_dir"));
        if configured.trim().is_empty() {
            crate::runtime_paths()?
                .output_dir
                .to_string_lossy()
                .to_string()
        } else {
            configured
        }
    };
    let base = {
        let configured = studio_value_to_string(node.params.get("output_name"));
        if configured.trim().is_empty() {
            format!("{}_grade", image_stem(&image_path))
        } else {
            configured.trim().to_string()
        }
    };
    studio_reject_unsafe_basename(&base)?;

    let ext = match param_or(node, "format", "png").as_str() {
        "tiff" => "tiff",
        _ => "png",
    };

    let dir = PathBuf::from(&output_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create output dir {}: {err}", dir.display()))?;
    let out_path = dir.join(format!("{base}.{ext}"));
    // Same write-skip contract as `crop`: when the image output only feeds
    // other compute cards, publish a deferred buffer instead of encoding.
    if skip_write_ports.contains("image") && !out_path.exists() {
        image_buffer::publish_working_deferred(&out_path, &graded, studio_image::png_output_meta());
    } else {
        studio_image::write_working_output(&out_path, &graded)?;
        image_buffer::publish_working(&out_path, &graded, studio_image::png_output_meta());
    }

    let ops: Vec<&hgripe_grade::GradeOp> = doc.layers.iter().flat_map(|l| l.ops.iter()).collect();
    let report = GradeReport {
        backend: backend.name.to_string(),
        backend_fallback_reason: backend.fallback_reason.clone(),
        layers: doc.layers.len(),
        ops: ops.len(),
        op_types: ops.iter().map(|op| op_type_tag(op)).collect(),
        source_mode: loaded.meta.source_mode.clone(),
        working_space: match image.space {
            WorkingSpace::Srgb => "srgb".to_string(),
            WorkingSpace::ProPhoto => "prophoto".to_string(),
        },
        input_size: [width, height],
        max_decode_pixels,
        processing_time_ms: started.elapsed().as_millis(),
    };
    let report = serde_json::to_value(&report)
        .map_err(|err| format!("failed to encode grade_report: {err}"))?;

    Ok(studio_output_map([
        ("image", json!(out_path.to_string_lossy())),
        ("grade_report", report),
    ]))
}

/// The grading dialog's preview payload: a graded sRGB PNG data URL plus the
/// backend that produced it.
#[derive(Debug, Serialize)]
pub(crate) struct GradePreviewResult {
    pub(crate) data_url: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) backend: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) backend_fallback_reason: Option<String>,
    pub(crate) elapsed_ms: u128,
}

/// Live preview for the grading dialog: decode `path`, downscale to at most
/// `max_dim` on the long edge, run `doc` over the sRGB preview surface and
/// return the result as a PNG data URL. Preview-grade by design: it grades
/// the display-space (sRGB 8-bit) proxy, while the node's run path grades the
/// full-precision working surface.
#[tauri::command]
pub(crate) fn grade_preview(
    path: String,
    doc: Value,
    max_dim: Option<u32>,
) -> Result<GradePreviewResult, String> {
    let started = Instant::now();
    let doc = parse_grade_doc(Some(&doc))?;
    let loaded = studio_image::load_working(
        Path::new(path.trim()),
        studio_image::DEFAULT_MAX_DECODE_PIXELS,
    )?;
    let srgb = loaded.image.to_srgb_rgba8();
    grade_srgb_preview(srgb, doc, max_dim, started)
}

/// Live preview for the video grading dialog: decode the frame nearest
/// `timestamp_sec` through the native media engine into the canonical
/// [`WorkingImage`] surface — the same working space stills use — then grade
/// the sRGB display proxy exactly like [`grade_preview`]. This is the Batch-3
/// media/colour bridge: a video frame reaches the grading kernel without a
/// PNG round-trip. Native-only: it drives the vendored libav decoder.
#[cfg(feature = "native-ffmpeg")]
#[tauri::command]
pub(crate) fn video_frame_grade_preview(
    video: String,
    timestamp_sec: f64,
    doc: Value,
    max_dim: Option<u32>,
) -> Result<GradePreviewResult, String> {
    let started = Instant::now();
    let doc = parse_grade_doc(Some(&doc))?;
    let working =
        super::ffmpeg_native::decode_frame_working(Path::new(video.trim()), timestamp_sec)?;
    let srgb = working.to_srgb_rgba8();
    grade_srgb_preview(srgb, doc, max_dim, started)
}

/// TS-facing result of a `.cube` LUT export.
#[derive(Debug, Serialize)]
pub(crate) struct CubeExportResult {
    pub(crate) path: String,
    pub(crate) size: u32,
    /// Spatial ops (blur/sharpen/denoise/grain/vignette) excluded from the
    /// bake — a LUT is a pure colour→colour map.
    pub(crate) skipped_spatial_ops: usize,
    /// Positional layer masks excluded from the bake (the layer still bakes,
    /// applied everywhere).
    pub(crate) dropped_masks: usize,
}

/// Bake a grade document to a `.cube` 3D LUT and write it under the project
/// output dir — the interchange path out of the grading dialog (Resolve,
/// FFmpeg `lut3d`, etc. consume the file). The bake samples the identity
/// lattice through the kernel in sRGB, the space the dialog previews in;
/// spatial ops and positional masks cannot live in a LUT and are excluded
/// (reported on the result).
#[tauri::command]
pub(crate) fn grade_export_cube(
    doc: Value,
    size: Option<u32>,
    output_name: Option<String>,
) -> Result<CubeExportResult, String> {
    let doc = parse_grade_doc(Some(&doc))?;
    let size = size.unwrap_or(33);
    let baked = hgripe_grade::bake_cube(&doc, size, GradeSpace::Srgb)?;

    let base = match output_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
    {
        Some(name) => name,
        None => format!(
            "grade_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ),
    };
    studio_reject_unsafe_basename(&base)?;
    let dir = crate::runtime_paths()?.output_dir;
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create output dir {}: {err}", dir.display()))?;
    let out_path = dir.join(format!("{base}.cube"));
    std::fs::write(&out_path, baked.cube)
        .map_err(|err| format!("failed to write {}: {err}", out_path.display()))?;
    Ok(CubeExportResult {
        path: out_path.to_string_lossy().to_string(),
        size,
        skipped_spatial_ops: baked.skipped_spatial_ops,
        dropped_masks: baked.dropped_masks,
    })
}

/// Downscale an sRGB proxy to at most `max_dim` on the long edge.
fn downscale_srgb(srgb: RgbaImage, max_dim: u32) -> RgbaImage {
    let (w, h) = srgb.dimensions();
    if w.max(h) <= max_dim {
        return srgb;
    }
    let scale = f64::from(max_dim) / f64::from(w.max(h));
    let nw = ((f64::from(w) * scale).round() as u32).max(1);
    let nh = ((f64::from(h) * scale).round() as u32).max(1);
    image::imageops::resize(&srgb, nw, nh, image::imageops::FilterType::Triangle)
}

/// Decode a still image and produce its display-space proxy at most `max_dim`
/// on the long edge. The decode+downscale half of the preview path, split out
/// so callers (the viewport host) can cache the proxy across parameter-only
/// re-renders such as slider drags.
pub(crate) fn load_image_srgb_proxy(path: &Path, max_dim: u32) -> Result<RgbaImage, String> {
    let loaded = studio_image::load_working(path, studio_image::DEFAULT_MAX_DECODE_PIXELS)?;
    Ok(downscale_srgb(loaded.image.to_srgb_rgba8(), max_dim))
}

/// Decode one video frame through the native media engine and produce its
/// display-space proxy at most `max_dim` on the long edge. Cacheable like
/// [`load_image_srgb_proxy`], keyed by path + timestamp.
#[cfg(feature = "native-ffmpeg")]
pub(crate) fn decode_video_srgb_proxy(
    video: &Path,
    timestamp_sec: f64,
    max_dim: u32,
) -> Result<RgbaImage, String> {
    let working = super::ffmpeg_native::decode_frame_working(video, timestamp_sec)?;
    Ok(downscale_srgb(working.to_srgb_rgba8(), max_dim))
}

/// Grade an sRGB 8-bit proxy and encode it as a PNG data URL — the shared tail
/// of both the still ([`grade_preview`]) and video
/// ([`video_frame_grade_preview`]) preview paths. Downscales to at most
/// `max_dim` on the long edge, runs `doc`, returns the result.
fn grade_srgb_preview(
    srgb: RgbaImage,
    doc: GradeDoc,
    max_dim: Option<u32>,
    started: Instant,
) -> Result<GradePreviewResult, String> {
    let max_dim = max_dim.unwrap_or(1280).clamp(16, 4096);
    let srgb = downscale_srgb(srgb, max_dim);
    grade_srgb_proxy(&srgb, &doc, started)
}

/// Run `doc` over an already-scaled sRGB proxy (no decode, no resize) and
/// encode the graded result as a PNG data URL. The per-tick cost of a slider
/// drag when the caller caches the proxy.
pub(crate) fn grade_srgb_proxy(
    srgb: &RgbaImage,
    doc: &GradeDoc,
    started: Instant,
) -> Result<GradePreviewResult, String> {
    let mut surface = srgb_proxy_surface(srgb)?;
    let backend = apply_grade_doc(doc, &mut surface);
    encode_surface_preview(&surface, backend, started)
}

/// Widen an sRGB 8-bit proxy to the kernel's f32 surface (no grading). Split
/// from [`grade_srgb_proxy`] so callers can run pipeline stages between the
/// kernel and the encode — e.g. the viewport's temporal denoise, which blends
/// the graded surface against the previous graded frame.
pub(crate) fn srgb_proxy_surface(srgb: &RgbaImage) -> Result<GradeSurface, String> {
    let (pw, ph) = srgb.dimensions();
    if pw == 0 || ph == 0 {
        return Err("Grade preview needs a non-empty image".to_string());
    }
    let data: Vec<f32> = srgb
        .as_raw()
        .iter()
        .map(|&v| f32::from(v) / 255.0)
        .collect();
    Ok(GradeSurface {
        w: pw,
        h: ph,
        data,
        space: GradeSpace::Srgb,
    })
}

/// Encode a graded sRGB surface as the preview's PNG data-URL payload — the
/// egress half of [`grade_srgb_proxy`].
pub(crate) fn encode_surface_preview(
    surface: &GradeSurface,
    backend: GradeBackend,
    started: Instant,
) -> Result<GradePreviewResult, String> {
    let graded = surface_to_rgba(surface)?;
    let (pw, ph) = graded.dimensions();
    let mut png: Vec<u8> = Vec::new();
    graded
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|err| format!("failed to encode preview png: {err}"))?;
    Ok(GradePreviewResult {
        data_url: format!(
            "data:image/png;base64,{}",
            crate::commands::thumbnails::base64_encode(&png)
        ),
        width: pw,
        height: ph,
        backend: backend.name,
        backend_fallback_reason: backend.fallback_reason,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// Quantise a graded f32 surface back to 8-bit sRGB pixels — the shared
/// ingress of both frame egress paths: PNG encoding (transport) and native
/// surface presentation (texture upload).
pub(crate) fn surface_to_rgba(surface: &GradeSurface) -> Result<RgbaImage, String> {
    let (pw, ph) = (surface.w, surface.h);
    let out: Vec<u8> = surface
        .data
        .iter()
        .map(|&v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();
    RgbaImage::from_raw(pw, ph, out)
        .ok_or_else(|| "graded preview buffer has the wrong size".to_string())
}

/// Previous-frame accumulator for video grading: `temporal_denoise` is not a
/// [`hgripe_grade::GradeOp`] (the op graph is stateless per frame) but a
/// pipeline stage fed the prior *graded* frame. The viewport host owns one
/// per video-grading viewport and calls [`TemporalAccumulator::push`] on each
/// frame after [`apply_grade_doc`]; a seek or source change calls
/// [`TemporalAccumulator::reset`].
#[derive(Default)]
pub(crate) struct TemporalAccumulator {
    prev: Option<GradeSurface>,
}

impl TemporalAccumulator {
    pub(crate) fn new() -> Self {
        Self { prev: None }
    }

    /// Drop the accumulated frame (on seek / source change), so the next
    /// frame passes through untouched and restarts the feedback chain.
    pub(crate) fn reset(&mut self) {
        self.prev = None;
    }

    /// Temporal-denoise `current` against the previous pushed frame (no-op on
    /// the first frame or after a reset), then record `current` as the new
    /// feedback frame.
    pub(crate) fn push(&mut self, current: &mut GradeSurface, amount: f32) {
        if let Some(prev) = &self.prev {
            hgripe_grade::temporal_denoise(current, prev, amount);
        }
        self.prev = Some(current.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(data: Vec<f32>) -> GradeSurface {
        GradeSurface {
            w: 1,
            h: 1,
            data,
            space: GradeSpace::Srgb,
        }
    }

    #[test]
    fn parse_grade_doc_accepts_missing_string_and_object_forms() {
        assert_eq!(parse_grade_doc(None).unwrap().layers.len(), 0);
        assert_eq!(parse_grade_doc(Some(&json!("  "))).unwrap().layers.len(), 0);
        let doc = json!({ "layers": [{ "blend": "normal", "opacity": 1.0, "visible": true, "mask": null, "ops": [{ "type": "exposure", "ev": 1.0 }] }] });
        assert_eq!(parse_grade_doc(Some(&doc)).unwrap().layers.len(), 1);
        let as_string = json!(doc.to_string());
        assert_eq!(parse_grade_doc(Some(&as_string)).unwrap().layers.len(), 1);
        assert!(parse_grade_doc(Some(&json!("not json"))).is_err());
    }

    #[test]
    fn apply_grade_doc_falls_back_to_cpu_and_grades() {
        let doc = parse_grade_doc(Some(&json!({
            "layers": [{ "blend": "normal", "opacity": 1.0, "visible": true, "mask": null,
                          "ops": [{ "type": "exposure", "ev": 1.0 }] }]
        })))
        .unwrap();
        let mut s = surface(vec![0.25, 0.25, 0.25, 1.0]);
        let backend = apply_grade_doc(&doc, &mut s);
        assert!(backend.name == "cpu" || backend.name == "gpu");
        assert!(
            backend.name == "gpu" || backend.fallback_reason.is_some(),
            "a CPU fallback must carry its reason"
        );
        assert!(s.data[0] > 0.25, "exposure should brighten");
    }

    #[test]
    fn temporal_accumulator_is_identity_on_first_frame_then_blends() {
        let mut acc = TemporalAccumulator::new();
        let mut a = surface(vec![0.0, 0.0, 0.0, 1.0]);
        acc.push(&mut a, 1.0);
        assert_eq!(a.data, vec![0.0, 0.0, 0.0, 1.0]);

        // A tiny frame-to-frame delta is averaged toward the previous frame;
        // after a reset the next frame passes through untouched again.
        let mut b = surface(vec![0.02, 0.02, 0.02, 1.0]);
        acc.push(&mut b, 1.0);
        assert!(b.data[0] < 0.02);

        acc.reset();
        let mut c = surface(vec![0.5, 0.5, 0.5, 1.0]);
        acc.push(&mut c, 1.0);
        assert_eq!(c.data, vec![0.5, 0.5, 0.5, 1.0]);
    }
}
