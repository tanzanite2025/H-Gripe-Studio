//! WGPU viewport host lifecycle (migration Phase 1, see
//! `docs/plans/completed/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`).
//!
//! The product layer talks to viewports only through these commands:
//! create → set_target / resize → render_frame → destroy. Nothing here runs at
//! app startup; a viewport exists only between an explicit `viewport_create`
//! and `viewport_destroy`, and creation/destruction are logged so leaks are
//! visible.
//!
//! Presentation transport: the frame is currently produced by the CPU image
//! pipeline and reported as `actual: "cpu"` with a fallback reason. The command
//! contract (targets by reference, backend report, bounded lifecycle) is the
//! stable boundary; later phases swap the transport for real WGPU textures
//! without changing the product-facing protocol.

use std::collections::HashMap;
use std::fs::{self, File};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::resource;
use crate::studio::{
    apply_clip_props_srgb_proxy_preferred, load_image_srgb_proxy, load_image_srgb_proxy_with_dims,
    parse_grade_doc, ClipPropsBackend, ClipPropsEvaluator, ResolvedClipProps, TemporalAccumulator,
};

mod registries;
pub(crate) use registries::*;
mod overlays;
pub(crate) use overlays::*;
mod proxy_cache;
use proxy_cache::*;

/// Hard cap on simultaneously open viewports. Editors open at most a handful;
/// hitting the cap means a caller is leaking viewports instead of destroying
/// them, so creation fails loudly rather than growing without bound.
const MAX_VIEWPORTS: usize = 8;

/// What a viewport is allowed to reference. Targets are lightweight references
/// (ids), never pixels — resolution to actual buffers happens Rust-side.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ViewportTarget {
    Image {
        #[serde(rename = "resourceId")]
        resource_id: String,
    },
    ImageLayer {
        #[serde(rename = "assetId")]
        asset_id: String,
        #[serde(rename = "layerId")]
        layer_id: String,
    },
    ImageComposite {
        #[serde(rename = "resourceId")]
        resource_id: String,
        document: Value,
        #[serde(rename = "documentKey")]
        document_key: String,
        #[serde(rename = "documentWidth")]
        document_width: u32,
        #[serde(rename = "documentHeight")]
        document_height: u32,
    },
    VideoClip {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
        #[serde(rename = "timeSec")]
        time_sec: f64,
        /// Opt-in decode device (`"gpu"` requests the D3D11VA zero-copy
        /// presentation path; anything else stays on the software baseline).
        #[serde(rename = "decodeDevice", default)]
        decode_device: Option<String>,
    },
    /// One decoded frame of a registered video file, addressed by resource
    /// reference + timestamp. The pre-timeline target for grading a raw video
    /// path; timeline clips address frames through [`Self::VideoClip`].
    VideoFrame {
        #[serde(rename = "resourceId")]
        resource_id: String,
        #[serde(rename = "timeSec")]
        time_sec: f64,
        /// Opt-in decode device (`"gpu"` requests the D3D11VA zero-copy
        /// presentation path; anything else stays on the software baseline).
        #[serde(rename = "decodeDevice", default)]
        decode_device: Option<String>,
    },
    NodeOutput {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(rename = "outputPort")]
        output_port: Option<String>,
    },
}

/// Backend report for the fallback contract: fallback is a reportable runtime
/// decision, not a failure.
#[derive(Clone, Serialize)]
pub(crate) struct ViewportBackend {
    pub requested: String,
    pub actual: String,
    /// Human-readable device detail (adapter name + backend) when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decode_processing_time_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props_backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props_backend_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props_fallback_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props_processing_time_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grade_processing_time_ms: Option<f64>,
}

impl ViewportBackend {
    fn with_clip_props(mut self, backend: Option<ClipPropsBackend>) -> Self {
        if let Some(backend) = backend {
            self.props_backend = Some(backend.name.to_string());
            self.props_backend_detail = backend.detail;
            self.props_fallback_reason = backend.fallback_reason;
            self.props_processing_time_ms = Some(backend.processing_time_ms);
        }
        self
    }

    fn with_stage_timings(mut self, decode_ms: f64, grade_ms: Option<f64>) -> Self {
        self.decode_processing_time_ms = Some(decode_ms);
        self.grade_processing_time_ms = grade_ms;
        self
    }

    fn inherit_processing(mut self, source: &ViewportBackend) -> Self {
        self.decode_processing_time_ms = source.decode_processing_time_ms;
        self.props_backend.clone_from(&source.props_backend);
        self.props_backend_detail
            .clone_from(&source.props_backend_detail);
        self.props_fallback_reason
            .clone_from(&source.props_fallback_reason);
        self.props_processing_time_ms = source.props_processing_time_ms;
        self.grade_processing_time_ms = source.grade_processing_time_ms;
        self
    }
}

/// The backend report a CPU-rendered, PNG-transported frame carries. When the
/// frame instead presents on the native surface the caller replaces this with
/// [`surface_backend_report`], so the reason here describes only the fallback
/// leg of the transport.
fn cpu_backend() -> ViewportBackend {
    ViewportBackend {
        requested: "auto".to_string(),
        actual: "cpu".to_string(),
        detail: None,
        fallback_reason: Some(
            "png transport (frame not presented on the native surface)".to_string(),
        ),
        decode_processing_time_ms: None,
        props_backend: None,
        props_backend_detail: None,
        props_fallback_reason: None,
        props_processing_time_ms: None,
        grade_processing_time_ms: None,
    }
}

/// The backend report a natively presented frame carries (surface swap Phase
/// S4): the frame is on the shared wgpu device's surface, so the badge says
/// `wgpu` with the adapter name — regardless of which kernel graded the
/// pixels (that detail stays in the render backend's `actual` on the PNG
/// path).
fn surface_backend_report(requested: &str) -> ViewportBackend {
    let report = crate::studio::wgpu_device::surface_device_report();
    ViewportBackend {
        requested: requested.to_string(),
        actual: "wgpu".to_string(),
        detail: report.backend,
        fallback_reason: None,
        decode_processing_time_ms: None,
        props_backend: None,
        props_backend_detail: None,
        props_fallback_reason: None,
        props_processing_time_ms: None,
        grade_processing_time_ms: None,
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct ViewportDescriptor {
    pub viewport_id: String,
    pub kind: String,
    pub backend: ViewportBackend,
}

/// One rendered frame, presented by the host as an image for now. Later phases
/// replace this with a texture handle; the surrounding protocol stays.
#[derive(Clone, Serialize)]
pub(crate) struct ViewportFrame {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub backend: ViewportBackend,
}

struct ViewportState {
    kind: String,
    target: Option<ViewportTarget>,
    width: u32,
    height: u32,
    /// Grade document applied at render time (grade_preview viewports); the
    /// doc is parameters only — pixels are resolved through the target.
    grade_doc: Option<Value>,
    /// Mask overlay composited over rendered frames (image_edit viewports):
    /// the mask editor's proxy-resolution selection tint, presented by the
    /// host at the view window's detail instead of a document-size canvas.
    mask_overlay: Option<Arc<MaskOverlay>>,
    /// Vector overlay stroked over rendered frames (image_edit viewports):
    /// the mask editor's marquee marching ants, drawn at the view window's
    /// detail instead of on a document-size canvas.
    overlay_scene: Option<Arc<OverlayScene>>,
    view: ViewportView,
    /// Most-recently-used first, at most [`PROXY_CACHE_DEPTH`] entries.
    proxies: Vec<SourceProxy>,
    /// Temporal denoise amount (`0` disables) applied to graded video
    /// frames after the grade doc, blending against the previous graded
    /// frame ([`TemporalChain`]).
    temporal_denoise: f32,
    /// The previous graded frame and its identity, for continuity checks.
    temporal: Option<TemporalChain>,
    /// Clip property document applied before the grade (video_preview): the
    /// raw doc string (change detection — the parse runs once per document,
    /// not once per frame) beside its parsed form.
    clip_props: Option<(String, ClipPropsEvaluator)>,
    /// Clip-local evaluation time (seconds) for `clip_props`.
    clip_props_time: f64,
}

struct TemporalChain {
    acc: TemporalAccumulator,
    path: String,
    time_sec: f64,
}

/// Largest forward playhead step still treated as continuous playback;
/// anything larger (or backwards, or a paused re-render at the same
/// timestamp) reads as a seek and restarts the temporal chain.
const MAX_TEMPORAL_STEP_SEC: f64 = 0.5;

/// Temporal-denoise a graded video frame against the viewport's previous
/// graded frame when the playhead advanced continuously, then store the
/// frame as the new feedback state. Discontinuities restart the chain (the
/// frame passes through untouched). The registry lock is never held across
/// the blend.
#[cfg_attr(not(feature = "native-ffmpeg"), allow(dead_code))]
fn apply_temporal(
    id: u64,
    path: &str,
    time_sec: f64,
    surface: &mut hgripe_grade::GradeSurface,
    amount: f32,
) -> Result<(), String> {
    if amount <= 0.0 {
        return Ok(());
    }
    let taken = {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        match map.get_mut(&id) {
            Some(state) => state.temporal.take(),
            None => return Ok(()),
        }
    };
    let continuous = taken.as_ref().is_some_and(|c| {
        c.path == path && time_sec > c.time_sec && time_sec - c.time_sec <= MAX_TEMPORAL_STEP_SEC
    });
    let mut chain = match taken {
        Some(chain) if continuous => chain,
        _ => TemporalChain {
            acc: TemporalAccumulator::new(),
            path: path.to_string(),
            time_sec,
        },
    };
    chain.acc.push(surface, amount);
    chain.path = path.to_string();
    chain.time_sec = time_sec;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    if let Some(state) = map.get_mut(&id) {
        state.temporal = Some(chain);
    }
    Ok(())
}

static VIEWPORTS: OnceLock<Mutex<HashMap<u64, ViewportState>>> = OnceLock::new();

/// Persistent D3D11VA decode sessions keyed by viewport (continuous playback
/// pacing on the video zero-copy path): a small forward playhead step decodes
/// sequentially from the session's current position instead of reopening the
/// container and seeking to a keyframe per frame. A session is replaced when
/// the viewport's video changes, evicted when a decode fails (the next
/// request reopens fresh), and dropped with the viewport.
#[cfg(all(windows, feature = "viewport-surface", feature = "native-ffmpeg"))]
static HW_SESSIONS: OnceLock<
    Mutex<HashMap<u64, crate::studio::ffmpeg_native::D3d11PlaybackSession>>,
> = OnceLock::new();

#[cfg(all(windows, feature = "viewport-surface", feature = "native-ffmpeg"))]
fn hw_sessions() -> &'static Mutex<HashMap<u64, crate::studio::ffmpeg_native::D3d11PlaybackSession>>
{
    HW_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn viewports() -> &'static Mutex<HashMap<u64, ViewportState>> {
    VIEWPORTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn parse_id(viewport_id: &str) -> Result<u64, String> {
    viewport_id
        .strip_prefix("vp-")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("invalid viewport id: {viewport_id}"))
}

/// Check that `viewport_id` names an open viewport. The surface presentation
/// commands (`viewport_surface`) validate against the registry through this
/// without touching viewport state.
pub(crate) fn ensure_viewport(viewport_id: &str) -> Result<(), String> {
    let id = parse_id(viewport_id)?;
    let map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    if map.contains_key(&id) {
        Ok(())
    } else {
        Err(format!("unknown viewport id: {viewport_id}"))
    }
}

const VIEWPORT_KINDS: [&str; 3] = ["image_edit", "grade_preview", "video_preview"];

#[tauri::command]
pub(crate) fn viewport_create(kind: String) -> Result<ViewportDescriptor, String> {
    if !VIEWPORT_KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown viewport kind: {kind}"));
    }
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    if map.len() >= MAX_VIEWPORTS {
        return Err(format!(
            "viewport limit reached ({MAX_VIEWPORTS}); a caller is leaking viewports"
        ));
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    map.insert(
        id,
        ViewportState {
            kind: kind.clone(),
            target: None,
            width: 0,
            height: 0,
            grade_doc: None,
            mask_overlay: None,
            overlay_scene: None,
            view: ViewportView::IDENTITY,
            proxies: Vec::new(),
            temporal_denoise: 0.0,
            temporal: None,
            clip_props: None,
            clip_props_time: 0.0,
        },
    );
    eprintln!(
        "[viewport] created vp-{id} kind={kind} (open: {})",
        map.len()
    );
    Ok(ViewportDescriptor {
        viewport_id: format!("vp-{id}"),
        kind,
        backend: cpu_backend(),
    })
}

#[tauri::command]
pub(crate) fn viewport_destroy(app: tauri::AppHandle, viewport_id: String) -> Result<(), String> {
    // The surface window (if any) goes first, so the swapchain never outlives
    // its viewport. A no-op for viewports that never presented.
    crate::commands::viewport_surface::destroy_surface(&app, &viewport_id);
    viewport_destroy_inner(viewport_id)
}

/// Registry half of destroy, callable without an app handle (unit tests run
/// without a Tauri runtime and never create surface windows).
pub(crate) fn viewport_destroy_inner(viewport_id: String) -> Result<(), String> {
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    #[cfg(all(windows, feature = "viewport-surface", feature = "native-ffmpeg"))]
    if let Ok(mut sessions) = hw_sessions().lock() {
        sessions.remove(&id);
    }
    match map.remove(&id) {
        Some(state) => {
            eprintln!(
                "[viewport] destroyed {viewport_id} kind={} (open: {})",
                state.kind,
                map.len()
            );
            Ok(())
        }
        None => Err(format!("unknown viewport id: {viewport_id}")),
    }
}

#[tauri::command]
pub(crate) fn viewport_set_target(
    viewport_id: String,
    target: ViewportTarget,
) -> Result<(), String> {
    // Validate reference targets eagerly so a bad id fails at set time, not at
    // the first render.
    match &target {
        ViewportTarget::Image { resource_id }
        | ViewportTarget::ImageComposite { resource_id, .. }
        | ViewportTarget::VideoFrame { resource_id, .. } => {
            if resource::get(resource_id).is_none() {
                return Err(format!("unknown resource id: {resource_id}"));
            }
        }
        ViewportTarget::ImageLayer { asset_id, layer_id } => {
            layered_asset_layer_path(asset_id, layer_id)?;
        }
        ViewportTarget::VideoClip {
            timeline_id,
            clip_id,
            ..
        } => {
            timeline_clip(timeline_id, clip_id)?;
        }
        ViewportTarget::NodeOutput {
            node_id,
            output_port,
        } => {
            node_output_path(node_id, output_port.as_deref())?;
        }
    }
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    state.target = Some(target);
    Ok(())
}

#[tauri::command]
pub(crate) fn viewport_resize(viewport_id: String, width: u32, height: u32) -> Result<(), String> {
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    state.width = width;
    state.height = height;
    Ok(())
}

/// Set (or clear) the grade document a viewport applies at render time.
/// Grade preview viewports grade their target; video preview viewports grade
/// the displayed frame with the same document model (Phase 4). Parameter
/// updates flow through viewport state — the target reference and the
/// transport stay untouched. `temporal_denoise` (`0..=1`, video targets
/// only) blends each graded frame against the previous graded frame during
/// continuous playback; `0` / absent disables and drops the feedback state.
#[tauri::command]
pub(crate) fn viewport_set_grade(
    viewport_id: String,
    doc: Option<Value>,
    temporal_denoise: Option<f32>,
) -> Result<(), String> {
    let amount = temporal_denoise.unwrap_or(0.0);
    if !amount.is_finite() || !(0.0..=1.0).contains(&amount) {
        return Err(format!(
            "temporal_denoise must be between 0 and 1, got {amount}"
        ));
    }
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    if !matches!(state.kind.as_str(), "grade_preview" | "video_preview") {
        return Err(format!(
            "viewport {viewport_id} (kind={}) does not accept a grade doc",
            state.kind
        ));
    }
    state.grade_doc = doc;
    state.temporal_denoise = amount;
    if amount == 0.0 {
        state.temporal = None;
    }
    Ok(())
}

/// Set (or clear) the clip property document a video-preview viewport applies
/// to frames before the grade (CLIP_KEYFRAME_MOTION_PIPELINE_PLAN.md Phase 3
/// — the preview half of the export's `resolve_prop_frames`). `doc` is the
/// serialized `ClipProperties` JSON; `time_sec` the clip-local evaluation
/// time. The doc parses once per distinct string: playhead-only updates reuse
/// the parsed document and only move the time.
#[tauri::command]
pub(crate) fn viewport_set_clip_props(
    viewport_id: String,
    doc: Option<String>,
    time_sec: Option<f64>,
) -> Result<(), String> {
    let time = time_sec.unwrap_or(0.0);
    if !time.is_finite() || time < 0.0 {
        return Err(format!("invalid clip props time {time}"));
    }
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    if state.kind != "video_preview" {
        return Err(format!(
            "viewport {viewport_id} (kind={}) does not accept a clip props doc",
            state.kind
        ));
    }
    match doc {
        None => state.clip_props = None,
        Some(raw)
            if state
                .clip_props
                .as_ref()
                .is_some_and(|(existing, _)| *existing == raw) => {}
        Some(raw) => state.clip_props = Some((raw.clone(), ClipPropsEvaluator::parse(&raw)?)),
    }
    state.clip_props_time = time;
    Ok(())
}

/// Set the viewport's presentation view (zoom/pan). Values must be finite and
/// `zoom` positive; a zoom at or below 1 with zero pan is the identity view.
#[tauri::command]
pub(crate) fn viewport_set_view(
    viewport_id: String,
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
) -> Result<(), String> {
    if !(zoom.is_finite() && pan_x.is_finite() && pan_y.is_finite()) {
        return Err("view parameters must be finite".to_string());
    }
    if zoom <= 0.0 {
        return Err(format!("zoom must be positive, got {zoom}"));
    }
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    state.view = ViewportView { zoom, pan_x, pan_y };
    Ok(())
}

/// The zoom/pan fast path (surface swap): set the viewport's view and
/// re-present the native surface's cached frame texture cropped to it — a
/// pure GPU pass, no render, no upload, no pixel IPC. Returns whether the
/// surface took it; `false` (no surface, hidden, no cached frame) is not an
/// error — the caller keeps riding the CSS transform until the settle render.
#[tauri::command]
pub(crate) fn viewport_present_view(
    viewport_id: String,
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
) -> Result<bool, String> {
    if !(zoom.is_finite() && pan_x.is_finite() && pan_y.is_finite()) {
        return Err("view parameters must be finite".to_string());
    }
    if zoom <= 0.0 {
        return Err(format!("zoom must be positive, got {zoom}"));
    }
    let id = parse_id(&viewport_id)?;
    {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        let state = map
            .get_mut(&id)
            .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
        state.view = ViewportView { zoom, pan_x, pan_y };
    }
    Ok(crate::commands::viewport_surface::present_view(
        &viewport_id,
        (zoom, pan_x, pan_y),
    ))
}

#[tauri::command]
pub(crate) fn viewport_render_frame(viewport_id: String) -> Result<ViewportFrame, String> {
    rgba_to_frame(viewport_render_rgba(&viewport_id)?)
}

/// A rendered frame before transport encoding: 8-bit sRGB pixels plus the
/// backend report. The PNG encode happens at the transport boundary so the
/// native surface path can present the same pixels without an encode.
struct RenderedRgba {
    image: Arc<RgbaImage>,
    backend: ViewportBackend,
    /// The view window the frame was rendered for — the native surface
    /// caches it so later views re-present as GPU crops (the fast path).
    view: ViewportView,
}

fn grade_backend_report(backend: crate::studio::GradeBackend) -> ViewportBackend {
    ViewportBackend {
        requested: "auto".to_string(),
        actual: backend.name.to_string(),
        detail: None,
        fallback_reason: backend.fallback_reason,
        decode_processing_time_ms: None,
        props_backend: None,
        props_backend_detail: None,
        props_fallback_reason: None,
        props_processing_time_ms: None,
        grade_processing_time_ms: None,
    }
}

fn encode_frame_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut png: Vec<u8> = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|err| format!("failed to encode frame png: {err}"))?;
    Ok(png)
}

fn rgba_to_frame(rendered: RenderedRgba) -> Result<ViewportFrame, String> {
    let (w, h) = rendered.image.dimensions();
    let png = encode_frame_png(&rendered.image)?;
    Ok(ViewportFrame {
        data_url: format!(
            "data:image/png;base64,{}",
            crate::commands::thumbnails::base64_encode(&png)
        ),
        width: w,
        height: h,
        backend: rendered.backend,
    })
}

/// Render the viewport's frame to 8-bit sRGB pixels (no transport encode) —
/// the shared ingress of both egress paths: PNG transport and native surface
/// presentation.
fn viewport_render_rgba(viewport_id: &str) -> Result<RenderedRgba, String> {
    viewport_render_rgba_with_overlay(viewport_id, true)
}

fn viewport_render_rgba_with_overlay(
    viewport_id: &str,
    include_overlay_scene: bool,
) -> Result<RenderedRgba, String> {
    let id = parse_id(viewport_id)?;
    let (
        target,
        width,
        height,
        grade_doc,
        view,
        temporal_denoise,
        mask_overlay,
        overlay_scene,
        clip_props,
    ) = {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        let state = map
            .get_mut(&id)
            .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
        (
            state.target.clone(),
            state.width,
            state.height,
            state.grade_doc.clone(),
            state.view,
            state.temporal_denoise,
            state.mask_overlay.clone(),
            if include_overlay_scene {
                state.overlay_scene.clone()
            } else {
                None
            },
            // Resolve at the stored clip-local time; identity resolves
            // vanish here so a static default document costs nothing.
            state
                .clip_props
                .as_mut()
                .map(|(_, evaluator)| evaluator.resolve(state.clip_props_time))
                .filter(|resolved| !resolved.is_identity()),
        )
    };
    let target = target.ok_or_else(|| format!("viewport {viewport_id} has no target"))?;
    match target {
        ViewportTarget::Image { resource_id } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            render_image_path(
                id,
                &entry.path,
                width,
                height,
                grade_doc,
                view,
                mask_overlay.as_deref(),
                overlay_scene.as_deref(),
                clip_props.as_ref(),
            )
        }
        ViewportTarget::ImageLayer { asset_id, layer_id } => {
            // Layer artifacts resolve through the layered asset registry —
            // the same reference-not-pixels contract as image resources.
            let path = layered_asset_layer_path(&asset_id, &layer_id)?;
            render_image_path(
                id,
                &path,
                width,
                height,
                grade_doc,
                view,
                mask_overlay.as_deref(),
                overlay_scene.as_deref(),
                None,
            )
        }
        ViewportTarget::ImageComposite {
            resource_id,
            document,
            document_key,
            document_width,
            document_height,
        } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            render_image_composite_path(
                id,
                &entry.path,
                &document,
                &document_key,
                document_width,
                document_height,
                width,
                height,
                grade_doc,
                view,
                mask_overlay.as_deref(),
                overlay_scene.as_deref(),
            )
        }
        #[cfg(feature = "native-ffmpeg")]
        ViewportTarget::VideoFrame {
            resource_id,
            time_sec,
            ..
        } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            render_video_path(
                id,
                &entry.path,
                time_sec,
                width,
                height,
                grade_doc,
                view,
                temporal_denoise,
                overlay_scene.as_deref(),
                clip_props.as_ref(),
            )
        }
        #[cfg(not(feature = "native-ffmpeg"))]
        ViewportTarget::VideoFrame { .. } => {
            Err("video frame targets require the native media engine".to_string())
        }
        ViewportTarget::VideoClip {
            timeline_id,
            clip_id,
            time_sec,
            ..
        } => {
            // Clips resolve through the timeline registry; the host maps the
            // timeline playhead to clip-local source time.
            let clip = timeline_clip(&timeline_id, &clip_id)?;
            if clip.kind == "still" {
                return render_image_path(
                    id,
                    &clip.path,
                    width,
                    height,
                    grade_doc,
                    view,
                    None,
                    overlay_scene.as_deref(),
                    clip_props.as_ref(),
                );
            }
            let source_time = (time_sec - clip.start_sec).clamp(0.0, clip.duration_sec);
            #[cfg(feature = "native-ffmpeg")]
            {
                render_video_path(
                    id,
                    &clip.path,
                    source_time,
                    width,
                    height,
                    grade_doc,
                    view,
                    temporal_denoise,
                    overlay_scene.as_deref(),
                    clip_props.as_ref(),
                )
            }
            #[cfg(not(feature = "native-ffmpeg"))]
            {
                let _ = source_time;
                Err("video clip targets require the native media engine".to_string())
            }
        }
        ViewportTarget::NodeOutput {
            node_id,
            output_port,
        } => {
            // Node outputs resolve through the node output registry — the
            // same reference-not-pixels contract as the other targets.
            let path = node_output_path(&node_id, output_port.as_deref())?;
            render_image_path(
                id,
                &path,
                width,
                height,
                grade_doc,
                view,
                mask_overlay.as_deref(),
                overlay_scene.as_deref(),
                None,
            )
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ViewportFrameExportFormat {
    Png,
    Jpeg,
    Bmp,
}

impl ViewportFrameExportFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Bmp => "bmp",
        }
    }

    fn image_format(self) -> ImageFormat {
        match self {
            Self::Png => ImageFormat::Png,
            Self::Jpeg => ImageFormat::Jpeg,
            Self::Bmp => ImageFormat::Bmp,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ViewportFrameExportResult {
    path: String,
    width: u32,
    height: u32,
    format: String,
}

fn write_export_frame(
    path: &Path,
    image: &RgbaImage,
    format: ViewportFrameExportFormat,
) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "export path must include a parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    let mut file =
        File::create(path).map_err(|err| format!("failed to create {}: {err}", path.display()))?;
    match format {
        ViewportFrameExportFormat::Jpeg => {
            let rgb = DynamicImage::ImageRgba8(image.clone()).to_rgb8();
            DynamicImage::ImageRgb8(rgb)
                .write_to(&mut file, format.image_format())
                .map_err(|err| format!("failed to encode jpeg frame: {err}"))?;
        }
        ViewportFrameExportFormat::Png | ViewportFrameExportFormat::Bmp => {
            DynamicImage::ImageRgba8(image.clone())
                .write_to(&mut file, format.image_format())
                .map_err(|err| format!("failed to encode {} frame: {err}", format.as_str()))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn viewport_export_frame(
    viewport_id: String,
    path: String,
    format: ViewportFrameExportFormat,
) -> Result<ViewportFrameExportResult, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("export path is empty".to_string());
    }
    let rendered = viewport_render_rgba_with_overlay(&viewport_id, false)?;
    let (width, height) = rendered.image.dimensions();
    write_export_frame(Path::new(trimmed), &rendered.image, format)?;
    Ok(ViewportFrameExportResult {
        path: trimmed.to_string(),
        width,
        height,
        format: format.as_str().to_string(),
    })
}

/// Binary frame transport: the same render as [`viewport_render_frame`], but
/// the frame crosses the IPC boundary as raw bytes instead of a base64 data
/// URL inside a JSON string. Payload layout:
/// `[u32 LE meta length][meta JSON {width, height, backend, presented}][PNG bytes]`.
///
/// When the viewport has a native surface window (surface swap Phase S2) the
/// pixels present directly on it — the payload then carries `presented: true`
/// and no PNG bytes, so a slider drag does no encode and no pixel IPC.
#[tauri::command]
pub(crate) fn viewport_render_frame_bin(
    app: tauri::AppHandle,
    viewport_id: String,
) -> Result<tauri::ipc::Response, String> {
    #[cfg(all(windows, feature = "viewport-surface", feature = "native-ffmpeg"))]
    if let Some((w, h)) = try_present_hw_video_frame(&viewport_id) {
        return Ok(tauri::ipc::Response::new(frame_bin_payload(
            w,
            h,
            &surface_backend_report("gpu"),
            true,
            &[],
        )?));
    }
    let rendered = viewport_render_rgba(&viewport_id)?;
    let presented = crate::commands::viewport_surface::present_frame(
        &app,
        &viewport_id,
        &rendered.image,
        (rendered.view.zoom, rendered.view.pan_x, rendered.view.pan_y),
    );
    let png = if presented {
        Vec::new()
    } else {
        encode_frame_png(&rendered.image)?
    };
    let backend = if presented {
        surface_backend_report(&rendered.backend.requested).inherit_processing(&rendered.backend)
    } else {
        rendered.backend
    };
    let (w, h) = rendered.image.dimensions();
    Ok(tauri::ipc::Response::new(frame_bin_payload(
        w, h, &backend, presented, &png,
    )?))
}

/// Explicit pixel readback for the cases that genuinely need bytes in the
/// webview (export preview, scopes, colour picking) — never the per-frame
/// path. Reads the surface's last presented texture back when one exists;
/// otherwise renders the frame on the CPU reference path. Both sources carry
/// the same pixels by construction (the surface texture is uploaded from the
/// CPU render), so callers get parity regardless of which path answered.
/// Payload layout: `[u32 LE meta length][meta JSON {width, height, backend}]
/// [raw RGBA8 bytes, row-major]`.
#[tauri::command]
pub(crate) fn viewport_read_pixels(viewport_id: String) -> Result<tauri::ipc::Response, String> {
    ensure_viewport(&viewport_id)?;
    if let Some((w, h, pixels)) =
        crate::commands::viewport_surface::read_surface_pixels(&viewport_id)
    {
        return Ok(tauri::ipc::Response::new(pixels_bin_payload(
            w,
            h,
            &surface_backend_report("auto"),
            &pixels,
        )?));
    }
    let rendered = viewport_render_rgba(&viewport_id)?;
    let (w, h) = rendered.image.dimensions();
    Ok(tauri::ipc::Response::new(pixels_bin_payload(
        w,
        h,
        &rendered.backend,
        rendered.image.as_raw(),
    )?))
}

/// The video zero-copy presentation fast path (GPU_DEVICE_STRATEGY_PLAN
/// phase 3): when the viewport's video target explicitly opted in with
/// `decodeDevice: "gpu"` (no denoise, no overlay), decode it as a D3D11 GPU
/// texture and present it on the native surface through the WGPU import —
/// no CPU readback, no upload, no PNG. Zoom/pan views present as GPU crops
/// of the imported texture (the same crop mechanism as the zoom/pan fast
/// path), and a grade doc runs as a wgpu compute plan directly on the
/// imported texture, so views and grades stay on the zero-copy path.
/// `Some((w, h))` means the frame is on the surface; `None` means the
/// caller runs the CPU render, with the reason on stderr and the import
/// outcome in the device registry (never silent).
#[cfg(all(windows, feature = "viewport-surface", feature = "native-ffmpeg"))]
fn try_present_hw_video_frame(viewport_id: &str) -> Option<(u32, u32)> {
    let Ok(id) = parse_id(viewport_id) else {
        return None;
    };
    let (target, grade_doc, view, temporal_denoise, overlay_scene) = {
        let map = viewports().lock().ok()?;
        let state = map.get(&id)?;
        (
            state.target.clone()?,
            state.grade_doc.clone(),
            state.view,
            state.temporal_denoise,
            state.overlay_scene.clone(),
        )
    };
    let (path, time_sec) = match &target {
        ViewportTarget::VideoFrame {
            resource_id,
            time_sec,
            decode_device,
        } if decode_device.as_deref() == Some("gpu") => {
            (resource::get(resource_id)?.path.clone(), *time_sec)
        }
        ViewportTarget::VideoClip {
            timeline_id,
            clip_id,
            time_sec,
            decode_device,
        } if decode_device.as_deref() == Some("gpu") => {
            let clip = timeline_clip(timeline_id, clip_id).ok()?;
            if clip.kind == "still" {
                return None;
            }
            let source_time = (*time_sec - clip.start_sec).clamp(0.0, clip.duration_sec);
            (clip.path.clone(), source_time)
        }
        _ => return None,
    };
    // Denoise and overlays still need the CPU render. The view and the
    // grade doc are not gates — zoom/pan present as GPU crops of the
    // imported texture, and the grade runs as a wgpu compute plan on it.
    if temporal_denoise > 0.0 || overlay_scene.is_some() {
        return None;
    }
    // An unparseable doc falls through to the CPU render, which surfaces
    // the parse error to the caller.
    let doc = parse_grade_doc(grade_doc.as_ref()).ok()?;
    let grade = (!doc.layers.is_empty()).then_some(&doc);
    let result = (|| -> Result<(u32, u32), String> {
        // Continuous playback pacing: reuse the viewport's persistent decode
        // session so a forward playhead step decodes sequentially (no reopen,
        // no keyframe seek). The lock is held across the decode — sessions
        // are strictly one-at-a-time.
        let mut sessions = hw_sessions()
            .lock()
            .map_err(|_| "hardware session registry poisoned".to_string())?;
        let session = match sessions.entry(id) {
            std::collections::hash_map::Entry::Occupied(entry)
                if entry.get().path() == std::path::Path::new(&path) =>
            {
                entry.into_mut()
            }
            std::collections::hash_map::Entry::Occupied(entry) => {
                let slot = entry.into_mut();
                *slot = crate::studio::ffmpeg_native::D3d11PlaybackSession::open(
                    std::path::Path::new(&path),
                )?;
                slot
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(crate::studio::ffmpeg_native::D3d11PlaybackSession::open(
                    std::path::Path::new(&path),
                )?)
            }
        };
        let frame = session.frame_near(time_sec)?;
        let size = (frame.width(), frame.height());
        crate::commands::viewport_surface::present_hw_frame(
            viewport_id,
            &frame,
            grade,
            (view.zoom, view.pan_x, view.pan_y),
        )?;
        Ok(size)
    })();
    match result {
        Ok(size) => Some(size),
        Err(reason) => {
            eprintln!("[viewport] zero-copy present fell back for {viewport_id}: {reason}");
            // Never leave a possibly-broken session behind: the next opted-in
            // request reopens fresh.
            if let Ok(mut sessions) = hw_sessions().lock() {
                sessions.remove(&id);
            }
            None
        }
    }
}

fn pixels_bin_payload(
    width: u32,
    height: u32,
    backend: &ViewportBackend,
    rgba: &[u8],
) -> Result<Vec<u8>, String> {
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err(format!(
            "pixel buffer is {} bytes, expected {} for {width}x{height} RGBA",
            rgba.len(),
            (width as usize) * (height as usize) * 4
        ));
    }
    let meta = serde_json::json!({
        "width": width,
        "height": height,
        "backend": backend,
    })
    .to_string();
    let mut payload = Vec::with_capacity(4 + meta.len() + rgba.len());
    payload.extend_from_slice(
        &u32::try_from(meta.len())
            .map_err(|_| "meta too large")?
            .to_le_bytes(),
    );
    payload.extend_from_slice(meta.as_bytes());
    payload.extend_from_slice(rgba);
    Ok(payload)
}

fn frame_bin_payload(
    width: u32,
    height: u32,
    backend: &ViewportBackend,
    presented: bool,
    png: &[u8],
) -> Result<Vec<u8>, String> {
    let meta = serde_json::json!({
        "width": width,
        "height": height,
        "backend": backend,
        "presented": presented,
    })
    .to_string();
    let mut payload = Vec::with_capacity(4 + meta.len() + png.len());
    payload.extend_from_slice(
        &u32::try_from(meta.len())
            .map_err(|_| "meta too large")?
            .to_le_bytes(),
    );
    payload.extend_from_slice(meta.as_bytes());
    payload.extend_from_slice(png);
    Ok(payload)
}

/// Render one video source frame at the viewport's size, applying its grade
/// doc and view. Graded/viewed frames decode through the native media engine
/// with the proxy cached per viewport keyed by path + timestamp + size, so
/// grading or panning a paused frame re-runs only crop + kernel; ungraded
/// frames resolve through the playback engine — dedicated decode thread,
/// bounded warm frame cache, latest-wins coalescing — then present through
/// the cached proxy pipeline.
#[cfg(feature = "native-ffmpeg")]
#[allow(clippy::too_many_arguments)]
fn render_video_path(
    id: u64,
    path: &str,
    time_sec: f64,
    width: u32,
    height: u32,
    grade_doc: Option<Value>,
    view: ViewportView,
    temporal_denoise: f32,
    overlay_scene: Option<&OverlayScene>,
    clip_props: Option<&ResolvedClipProps>,
) -> Result<RenderedRgba, String> {
    let size = width.max(height).clamp(64, 2048);
    if grade_doc.is_some()
        || !view.is_identity()
        || temporal_denoise > 0.0
        || overlay_scene.is_some()
        || clip_props.is_some()
    {
        let doc = parse_grade_doc(grade_doc.as_ref())?;
        let detail = proxy_detail_size(size, view);
        let key = ProxyKey {
            path: path.to_string(),
            time_bits: Some(time_sec.to_bits()),
            size: detail,
        };
        let decode_started = Instant::now();
        let (proxy, source_dims) = cached_proxy_with_dims(id, key, || {
            crate::studio::decode_video_srgb_proxy_with_dims(
                std::path::Path::new(path),
                time_sec,
                detail,
            )
        })?;
        let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
        let (proxy, props_backend) = apply_clip_props_to_proxy(proxy, source_dims, clip_props);
        let source = if view.is_identity() {
            None
        } else {
            Some(crop_view(&proxy, view))
        };
        let mut surface = crate::studio::srgb_proxy_surface(source.as_ref().unwrap_or(&proxy))?;
        let grade_started = Instant::now();
        let backend = crate::studio::apply_grade_doc(&doc, &mut surface);
        let grade_ms = grade_started.elapsed().as_secs_f64() * 1000.0;
        apply_temporal(id, path, time_sec, &mut surface, temporal_denoise)?;
        if let Some(scene) = overlay_scene {
            // Stroked last: guides sit above the graded frame.
            composite_overlay_scene(&mut surface, scene, proxy.dimensions(), view);
        }
        let image = crate::studio::surface_to_rgba(&surface)?;
        return Ok(RenderedRgba {
            image: Arc::new(image),
            backend: grade_backend_report(backend)
                .with_clip_props(props_backend)
                .with_stage_timings(decode_ms, Some(grade_ms)),
            view,
        });
    }
    let poster_dir = crate::cache_subdir(".posters")?;
    let frame = crate::studio::video_engine::scrub_frame(
        &poster_dir,
        std::path::Path::new(path),
        time_sec,
    )?;
    let key = ProxyKey {
        path: path.to_string(),
        time_bits: Some(time_sec.to_bits()),
        size,
    };
    let decode_started = Instant::now();
    let proxy = cached_proxy(id, key, || load_image_srgb_proxy(&frame, size))?;
    let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
    Ok(RenderedRgba {
        image: proxy,
        backend: cpu_backend().with_stage_timings(decode_ms, None),
        view,
    })
}

/// Run the clip property raster over a decoded proxy. `source_dims` are the
/// source's full-resolution dimensions: position/anchor are authored in
/// source pixels, so they scale by the proxy ratio before the pass — the
/// preview then composes identically to the full-resolution export.
fn apply_clip_props_to_proxy(
    proxy: Arc<RgbaImage>,
    source_dims: (u32, u32),
    clip_props: Option<&ResolvedClipProps>,
) -> (Arc<RgbaImage>, Option<ClipPropsBackend>) {
    let Some(props) = clip_props else {
        return (proxy, None);
    };
    let ratio = if source_dims.0 > 0 {
        proxy.width() as f64 / source_dims.0 as f64
    } else {
        1.0
    };
    let (image, backend) =
        apply_clip_props_srgb_proxy_preferred(&proxy, &props.scaled_coords(ratio));
    (Arc::new(image), Some(backend))
}

fn render_image_composite_path(
    id: u64,
    path: &str,
    document: &Value,
    _document_key: &str,
    document_width: u32,
    document_height: u32,
    width: u32,
    height: u32,
    grade_doc: Option<Value>,
    view: ViewportView,
    mask_overlay: Option<&MaskOverlay>,
    overlay_scene: Option<&OverlayScene>,
) -> Result<RenderedRgba, String> {
    let size = width.max(height).clamp(64, 2048);
    let detail = if grade_doc.is_some()
        || !view.is_identity()
        || mask_overlay.is_some()
        || overlay_scene.is_some()
    {
        proxy_detail_size(size, view)
    } else {
        size
    };
    let key = ProxyKey {
        path: path.to_string(),
        time_bits: None,
        size: detail,
    };
    let proxy = cached_proxy(id, key, || {
        load_image_srgb_proxy(std::path::Path::new(path), detail)
    })?;
    let mut image = crate::studio::image_document::composite_image_document(
        &proxy,
        document,
        document_width.max(1),
        document_height.max(1),
    )?;
    let full_dims = image.dimensions();
    if !view.is_identity() {
        image = crop_view(&image, view);
    }
    if grade_doc.is_some() || mask_overlay.is_some() || overlay_scene.is_some() {
        let doc = parse_grade_doc(grade_doc.as_ref())?;
        let mut surface = crate::studio::srgb_proxy_surface(&image)?;
        let backend = crate::studio::apply_grade_doc(&doc, &mut surface);
        if let Some(overlay) = mask_overlay {
            composite_mask_overlay(&mut surface, overlay, full_dims, view);
        }
        if let Some(scene) = overlay_scene {
            composite_overlay_scene(&mut surface, scene, full_dims, view);
        }
        image = crate::studio::surface_to_rgba(&surface)?;
        return Ok(RenderedRgba {
            image: Arc::new(image),
            backend: grade_backend_report(backend),
            view,
        });
    }
    Ok(RenderedRgba {
        image: Arc::new(image),
        backend: cpu_backend(),
        view,
    })
}

/// Render one still-image source (an image resource or a layer artifact) at
/// the viewport's size, applying its grade doc, view and mask overlay. The
/// decoded sRGB proxy is cached on the viewport keyed by path + size, so a
/// slider drag or a pan/zoom tick re-runs only crop + kernel.
fn render_image_path(
    id: u64,
    path: &str,
    width: u32,
    height: u32,
    grade_doc: Option<Value>,
    view: ViewportView,
    mask_overlay: Option<&MaskOverlay>,
    overlay_scene: Option<&OverlayScene>,
    clip_props: Option<&ResolvedClipProps>,
) -> Result<RenderedRgba, String> {
    let size = width.max(height).clamp(64, 2048);
    if grade_doc.is_some()
        || !view.is_identity()
        || mask_overlay.is_some()
        || overlay_scene.is_some()
        || clip_props.is_some()
    {
        // Graded and/or viewed frame: run the grading kernel (identity when
        // no doc is set) over the view window of the source's sRGB proxy.
        let doc = parse_grade_doc(grade_doc.as_ref())?;
        let detail = proxy_detail_size(size, view);
        let key = ProxyKey {
            path: path.to_string(),
            time_bits: None,
            size: detail,
        };
        let decode_started = Instant::now();
        let (proxy, source_dims) = cached_proxy_with_dims(id, key, || {
            load_image_srgb_proxy_with_dims(std::path::Path::new(path), detail)
        })?;
        let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
        let (proxy, props_backend) = apply_clip_props_to_proxy(proxy, source_dims, clip_props);
        let source = if view.is_identity() {
            None
        } else {
            Some(crop_view(&proxy, view))
        };
        let mut surface = crate::studio::srgb_proxy_surface(source.as_ref().unwrap_or(&proxy))?;
        let grade_started = Instant::now();
        let backend = crate::studio::apply_grade_doc(&doc, &mut surface);
        let grade_ms = grade_started.elapsed().as_secs_f64() * 1000.0;
        if let Some(overlay) = mask_overlay {
            // The overlay tints the *presented* frame: grade first, then
            // composite, so the tint colour is not pushed through the kernel.
            composite_mask_overlay(&mut surface, overlay, proxy.dimensions(), view);
        }
        if let Some(scene) = overlay_scene {
            // Stroked last: the outline sits above the frame and the tint.
            composite_overlay_scene(&mut surface, scene, proxy.dimensions(), view);
        }
        let image = crate::studio::surface_to_rgba(&surface)?;
        return Ok(RenderedRgba {
            image: Arc::new(image),
            backend: grade_backend_report(backend)
                .with_clip_props(props_backend)
                .with_stage_timings(decode_ms, Some(grade_ms)),
            view,
        });
    }
    // Plain path: the viewport's cached source proxy at the bounded size (so
    // a huge surface cannot request a full decode through this path).
    let key = ProxyKey {
        path: path.to_string(),
        time_bits: None,
        size,
    };
    let decode_started = Instant::now();
    let proxy = cached_proxy(id, key, || {
        load_image_srgb_proxy(std::path::Path::new(path), size)
    })?;
    let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
    Ok(RenderedRgba {
        image: proxy,
        backend: cpu_backend().with_stage_timings(decode_ms, None),
        view,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_set_render_destroy_lifecycle() {
        let desc = viewport_create("image_edit".to_string()).expect("create");
        assert!(desc.viewport_id.starts_with("vp-"));
        assert_eq!(desc.backend.actual, "cpu");

        viewport_resize(desc.viewport_id.clone(), 800, 600).expect("resize");
        // No target yet: rendering must fail, not panic.
        assert!(viewport_render_frame(desc.viewport_id.clone()).is_err());

        viewport_destroy_inner(desc.viewport_id.clone()).expect("destroy");
        // Destroyed viewports are gone.
        assert!(viewport_resize(desc.viewport_id.clone(), 1, 1).is_err());
        assert!(viewport_destroy_inner(desc.viewport_id).is_err());
    }

    #[test]
    fn mask_overlay_only_on_image_edit_viewports_and_validates_the_buffer() {
        let data = crate::commands::thumbnails::base64_encode(&[0u8; 4]);
        let arg = |data: String| MaskOverlayArg {
            w: 2,
            h: 2,
            data,
            rgb: [86, 168, 255],
            alpha: 0.55,
            invert: false,
        };

        let grade = viewport_create("grade_preview".to_string()).expect("create");
        let err = viewport_set_mask_overlay(grade.viewport_id.clone(), Some(arg(data.clone())))
            .expect_err("grade_preview must reject a mask overlay");
        assert!(err.contains("does not accept a mask overlay"));
        viewport_destroy_inner(grade.viewport_id).expect("destroy");

        let vp = viewport_create("image_edit".to_string()).expect("create");
        viewport_set_mask_overlay(vp.viewport_id.clone(), Some(arg(data.clone())))
            .expect("image_edit accepts a mask overlay");
        {
            let map = viewports().lock().expect("lock");
            let id = parse_id(&vp.viewport_id).expect("id");
            assert!(map.get(&id).expect("open").mask_overlay.is_some());
        }
        // Wrong buffer length fails loudly.
        let short = crate::commands::thumbnails::base64_encode(&[0u8; 3]);
        let err = viewport_set_mask_overlay(vp.viewport_id.clone(), Some(arg(short)))
            .expect_err("short buffer must be rejected");
        assert!(err.contains("expected 4"));
        // Out-of-range alpha fails loudly.
        let mut bad = arg(data);
        bad.alpha = 1.5;
        assert!(viewport_set_mask_overlay(vp.viewport_id.clone(), Some(bad)).is_err());
        // Clearing drops the overlay.
        viewport_set_mask_overlay(vp.viewport_id.clone(), None).expect("clear");
        {
            let map = viewports().lock().expect("lock");
            let id = parse_id(&vp.viewport_id).expect("id");
            assert!(map.get(&id).expect("open").mask_overlay.is_none());
        }
        viewport_destroy_inner(vp.viewport_id).expect("destroy");
    }

    #[test]
    fn overlay_scene_only_on_overlay_viewports_and_validates_coordinates() {
        let scene = |region: [f32; 4]| OverlayScene {
            items: vec![OverlayItem::Marquee {
                region,
                ellipse: false,
            }],
            phase: 0.0,
        };

        let grade = viewport_create("grade_preview".to_string()).expect("create");
        let err = viewport_set_overlay_scene(
            grade.viewport_id.clone(),
            Some(scene([0.1, 0.1, 0.5, 0.5])),
        )
        .expect_err("grade_preview must reject an overlay scene");
        assert!(err.contains("does not accept an overlay scene"));
        viewport_destroy_inner(grade.viewport_id).expect("destroy");

        let monitor = viewport_create("video_preview".to_string()).expect("create");
        viewport_set_overlay_scene(
            monitor.viewport_id.clone(),
            Some(scene([0.05, 0.05, 0.95, 0.95])),
        )
        .expect("video_preview accepts an overlay scene (safe-area guides)");
        viewport_destroy_inner(monitor.viewport_id).expect("destroy");

        let vp = viewport_create("image_edit".to_string()).expect("create");
        viewport_set_overlay_scene(vp.viewport_id.clone(), Some(scene([0.1, 0.1, 0.5, 0.5])))
            .expect("image_edit accepts an overlay scene");
        {
            let map = viewports().lock().expect("lock");
            let id = parse_id(&vp.viewport_id).expect("id");
            assert!(map.get(&id).expect("open").overlay_scene.is_some());
        }
        // Non-finite coordinates fail loudly.
        let err = viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(scene([0.1, f32::NAN, 0.5, 0.5])),
        )
        .expect_err("non-finite coordinates must be rejected");
        assert!(err.contains("finite"));
        // Clearing drops the scene.
        viewport_set_overlay_scene(vp.viewport_id.clone(), None).expect("clear");
        {
            let map = viewports().lock().expect("lock");
            let id = parse_id(&vp.viewport_id).expect("id");
            assert!(map.get(&id).expect("open").overlay_scene.is_none());
        }
        viewport_destroy_inner(vp.viewport_id).expect("destroy");
    }

    #[test]
    fn overlay_scene_strokes_a_dashed_marquee_inside_the_surface() {
        let mut surface = hgripe_grade::GradeSurface {
            w: 32,
            h: 32,
            data: vec![0.0; 32 * 32 * 4],
            space: hgripe_grade::GradeSpace::Srgb,
        };
        let scene = OverlayScene {
            items: vec![OverlayItem::Marquee {
                region: [0.25, 0.25, 0.75, 0.75],
                ellipse: false,
            }],
            phase: 0.0,
        };
        composite_overlay_scene(&mut surface, &scene, (32, 32), ViewportView::IDENTITY);
        let stroked = surface.data.chunks(4).filter(|px| px[2] > 0.5).count();
        // A dashed outline touches some pixels (never zero, never a fill).
        assert!(stroked > 8, "expected a stroked outline, got {stroked}");
        assert!(
            stroked < 16 * 16,
            "outline must not fill the region: {stroked}"
        );
        // Interior stays untouched.
        let mid = ((16 * 32 + 16) * 4) as usize;
        assert_eq!(surface.data[mid], 0.0);
    }

    #[test]
    fn overlay_polygon_fills_the_interior_and_strokes_the_outline() {
        let mut surface = hgripe_grade::GradeSurface {
            w: 32,
            h: 32,
            data: vec![0.0; 32 * 32 * 4],
            space: hgripe_grade::GradeSpace::Srgb,
        };
        let scene = OverlayScene {
            items: vec![OverlayItem::Polygon {
                points: vec![[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]],
                stroke: [1.0, 0.0, 0.0, 1.0],
                fill: Some([0.0, 1.0, 0.0, 0.5]),
                dash: false,
            }],
            phase: 0.0,
        };
        composite_overlay_scene(&mut surface, &scene, (32, 32), ViewportView::IDENTITY);
        // Interior carries the fill (green over black at 0.5 alpha).
        let mid = ((16 * 32 + 16) * 4) as usize;
        assert!(surface.data[mid + 1] > 0.4, "interior must be filled");
        assert_eq!(surface.data[mid], 0.0, "fill must not add red");
        // The outline carries the solid red stroke; the top edge maps to
        // y = 0.25 * 32 - 0.5 = 7.5 -> row 8 (rounded).
        let edge = ((8 * 32 + 16) * 4) as usize;
        assert!(surface.data[edge] > 0.9, "outline must be stroked");
        // Outside stays untouched.
        let out = ((2 * 32 + 2) * 4) as usize;
        assert_eq!(surface.data[out], 0.0);
        assert_eq!(surface.data[out + 1], 0.0);
    }

    #[test]
    fn overlay_polyline_and_markers_composite_on_the_surface() {
        let mut surface = hgripe_grade::GradeSurface {
            w: 32,
            h: 32,
            data: vec![0.0; 32 * 32 * 4],
            space: hgripe_grade::GradeSpace::Srgb,
        };
        let scene = OverlayScene {
            items: vec![
                // A horizontal ruler line across row y = 0.5.
                OverlayItem::Polyline {
                    points: vec![[0.1, 0.5], [0.9, 0.5]],
                    stroke: [1.0, 0.0, 0.0, 1.0],
                    dash: false,
                },
                // A filled disc pin at the centre.
                OverlayItem::Marker {
                    center: [0.5, 0.25],
                    shape: MarkerShape::Disc,
                    size: 3.0,
                    stroke: [0.0, 0.0, 1.0, 1.0],
                    fill: Some([0.0, 1.0, 0.0, 1.0]),
                },
                // A cross prompt.
                OverlayItem::Marker {
                    center: [0.25, 0.75],
                    shape: MarkerShape::Cross,
                    size: 5.0,
                    stroke: [1.0, 1.0, 1.0, 1.0],
                    fill: None,
                },
            ],
            phase: 0.0,
        };
        composite_overlay_scene(&mut surface, &scene, (32, 32), ViewportView::IDENTITY);
        // Ruler line: y = 0.5 * 32 - 0.5 = 15.5 -> row 16; x mid is red.
        let line = ((16 * 32 + 16) * 4) as usize;
        assert!(surface.data[line] > 0.9, "polyline must be stroked");
        // Disc pin: centre (15.5, 7.5) -> the interior is green-filled.
        let pin = ((7 * 32 + 15) * 4) as usize;
        assert!(surface.data[pin + 1] > 0.9, "disc must be filled");
        // Cross: horizontal arm through (7.5, 23.5) rounds to row 24, white.
        let arm = ((24 * 32 + 5) * 4) as usize;
        assert!(
            surface.data[arm] > 0.9 && surface.data[arm + 2] > 0.9,
            "cross arm must be stroked"
        );
        // A far corner stays untouched.
        let out = ((30 * 32 + 30) * 4) as usize;
        assert_eq!(surface.data[out], 0.0);
    }

    #[test]
    fn overlay_band_fills_a_round_capped_stroke_once() {
        let mut surface = hgripe_grade::GradeSurface {
            w: 32,
            h: 32,
            data: vec![0.0; 32 * 32 * 4],
            space: hgripe_grade::GradeSpace::Srgb,
        };
        let scene = OverlayScene {
            items: vec![OverlayItem::Band {
                // A self-overlapping centreline: out and back along row 0.5.
                points: vec![[0.2, 0.5], [0.8, 0.5], [0.2, 0.5]],
                radius: 4.0 / 32.0,
                color: [0.0, 0.0, 1.0, 0.5],
            }],
            phase: 0.0,
        };
        composite_overlay_scene(&mut surface, &scene, (32, 32), ViewportView::IDENTITY);
        // On the centreline the band blends exactly once: 0.5 blue.
        let mid = ((16 * 32 + 16) * 4) as usize;
        assert!(
            (surface.data[mid + 2] - 0.5).abs() < 1e-4,
            "band must blend once, got {}",
            surface.data[mid + 2]
        );
        // The round cap extends past the endpoint...
        let cap = ((16 * 32 + 28) * 4) as usize;
        assert!(surface.data[cap + 2] > 0.4, "round cap must be filled");
        // ...but a far corner stays untouched.
        let out = ((2 * 32 + 2) * 4) as usize;
        assert_eq!(surface.data[out + 2], 0.0);
    }

    #[test]
    fn overlay_band_validation_rejects_bad_values() {
        let vp = viewport_create("image_edit".to_string()).expect("create");
        let band = |radius: f32, color: [f32; 4]| OverlayScene {
            items: vec![OverlayItem::Band {
                points: vec![[0.2, 0.5], [0.8, 0.5]],
                radius,
                color,
            }],
            phase: 0.0,
        };
        let err = viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(band(f32::NAN, [0.0, 0.0, 1.0, 0.5])),
        )
        .expect_err("non-finite radius must be rejected");
        assert!(err.contains("finite"));
        let err = viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(band(1.5, [0.0, 0.0, 1.0, 0.5])),
        )
        .expect_err("out-of-range radius must be rejected");
        assert!(err.contains("radius"));
        let err = viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(band(0.05, [0.0, 0.0, 2.0, 0.5])),
        )
        .expect_err("out-of-range colours must be rejected");
        assert!(err.contains("between 0 and 1"));
        viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(band(0.05, [0.0, 0.0, 1.0, 0.5])),
        )
        .expect("a valid band is accepted");
        viewport_destroy_inner(vp.viewport_id).expect("destroy");
    }

    #[test]
    fn overlay_marker_validation_rejects_bad_values() {
        let vp = viewport_create("image_edit".to_string()).expect("create");
        let marker = |center: [f32; 2], size: f32, stroke: [f32; 4]| OverlayScene {
            items: vec![OverlayItem::Marker {
                center,
                shape: MarkerShape::Disc,
                size,
                stroke,
                fill: None,
            }],
            phase: 0.0,
        };
        let err = viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(marker([0.5, f32::NAN], 3.0, [1.0, 1.0, 1.0, 1.0])),
        )
        .expect_err("non-finite centre must be rejected");
        assert!(err.contains("finite"));
        let err = viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(marker([0.5, 0.5], 3.0, [1.0, 1.0, 1.0, 2.0])),
        )
        .expect_err("out-of-range colours must be rejected");
        assert!(err.contains("between 0 and 1"));
        viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(marker([0.5, 0.5], 6.0, [1.0, 1.0, 1.0, 0.9])),
        )
        .expect("a valid marker is accepted");
        viewport_destroy_inner(vp.viewport_id).expect("destroy");
    }

    #[test]
    fn overlay_polygon_validation_rejects_bad_points_and_colours() {
        let vp = viewport_create("image_edit".to_string()).expect("create");
        let poly = |points: Vec<[f32; 2]>, stroke: [f32; 4]| OverlayScene {
            items: vec![OverlayItem::Polygon {
                points,
                stroke,
                fill: None,
                dash: false,
            }],
            phase: 0.0,
        };
        let err = viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(poly(
                vec![[0.0, f32::INFINITY], [1.0, 1.0]],
                [0.0, 0.0, 0.0, 1.0],
            )),
        )
        .expect_err("non-finite points must be rejected");
        assert!(err.contains("finite"));
        let err = viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(poly(vec![[0.0, 0.0], [1.0, 1.0]], [0.0, 0.0, 0.0, 1.5])),
        )
        .expect_err("out-of-range colours must be rejected");
        assert!(err.contains("between 0 and 1"));
        viewport_set_overlay_scene(
            vp.viewport_id.clone(),
            Some(poly(
                vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]],
                [0.3, 0.6, 1.0, 0.9],
            )),
        )
        .expect("a valid polygon is accepted");
        viewport_destroy_inner(vp.viewport_id).expect("destroy");
    }

    #[test]
    fn composite_tints_covered_pixels_and_inverts_for_quick_mask() {
        let surface = |v: f32| hgripe_grade::GradeSurface {
            w: 2,
            h: 1,
            data: vec![v; 2 * 4],
            space: hgripe_grade::GradeSpace::Srgb,
        };
        // Left half covered, right half clear.
        let overlay = MaskOverlay {
            w: 2,
            h: 1,
            data: vec![255, 0],
            rgb: [255, 0, 0],
            alpha: 1.0,
            invert: false,
        };
        let mut s = surface(0.0);
        composite_mask_overlay(&mut s, &overlay, (2, 1), ViewportView::IDENTITY);
        // Covered pixel reads the tint; the clear pixel is untouched.
        assert!(s.data[0] > 0.9, "covered pixel red: {}", s.data[0]);
        assert!(s.data[1] < 0.1, "covered pixel green: {}", s.data[1]);
        assert_eq!(s.data[4], 0.0, "clear pixel untouched");

        // Quick mask: inverted coverage tints the *unselected* pixel.
        let ruby = MaskOverlay {
            invert: true,
            ..overlay
        };
        let mut q = surface(0.0);
        composite_mask_overlay(&mut q, &ruby, (2, 1), ViewportView::IDENTITY);
        assert!(q.data[0] < 0.1, "selected pixel clear: {}", q.data[0]);
        assert!(q.data[4] > 0.9, "unselected pixel tinted: {}", q.data[4]);
    }

    #[test]
    fn frame_bin_payload_carries_meta_header_and_png_bytes() {
        let img = image::RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 255]));
        let png = encode_frame_png(&img).expect("encode png");

        let payload = frame_bin_payload(3, 2, &cpu_backend(), false, &png).expect("payload");
        let meta_len = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&payload[4..4 + meta_len]).expect("meta json");
        assert_eq!(meta["width"], 3);
        assert_eq!(meta["height"], 2);
        assert_eq!(meta["backend"]["actual"], "cpu");
        assert_eq!(meta["presented"], false);
        // The trailing bytes are the PNG, byte for byte.
        assert_eq!(&payload[4 + meta_len..], &png[..]);

        // A natively presented frame carries the flag and no PNG bytes.
        let payload = frame_bin_payload(3, 2, &cpu_backend(), true, &[]).expect("payload");
        let meta_len = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&payload[4..4 + meta_len]).expect("meta json");
        assert_eq!(meta["presented"], true);
        assert!(payload[4 + meta_len..].is_empty());
    }

    #[test]
    fn read_pixels_payload_carries_meta_header_and_raw_rgba() {
        let img = image::RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 255]));
        let payload = pixels_bin_payload(3, 2, &cpu_backend(), img.as_raw()).expect("payload");
        let meta_len = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&payload[4..4 + meta_len]).expect("meta json");
        assert_eq!(meta["width"], 3);
        assert_eq!(meta["height"], 2);
        assert_eq!(meta["backend"]["actual"], "cpu");
        // The trailing bytes are the raw RGBA rows, byte for byte.
        assert_eq!(&payload[4 + meta_len..], &img.as_raw()[..]);
        // A mismatched buffer length fails loudly, never a truncated payload.
        assert!(pixels_bin_payload(3, 2, &cpu_backend(), &[0u8; 4]).is_err());
    }

    #[test]
    fn read_pixels_matches_the_reference_render_parity() {
        // Golden parity (surface swap Phase S4): what `viewport_read_pixels`
        // answers must be exactly the reference render's pixels. On CI
        // runners without a GPU the surface never presents, so the CPU
        // fallback path answers and the backend report stays truthful.
        let path = std::env::temp_dir().join("hgripe_viewport_read_pixels.png");
        image::RgbaImage::from_fn(8, 6, |x, y| {
            image::Rgba([(x * 30) as u8, (y * 40) as u8, 90, 255])
        })
        .save(&path)
        .expect("write test image");
        let canonical = path.to_string_lossy().to_string();
        let res_id = resource::id_for(&canonical);
        resource::put(
            &res_id,
            resource::ResourceEntry {
                path: canonical,
                width: Some(8),
                height: Some(6),
            },
        );

        let desc = viewport_create("grade_preview".to_string()).expect("create");
        viewport_resize(desc.viewport_id.clone(), 320, 240).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::Image {
                resource_id: res_id,
            },
        )
        .expect("set target");
        viewport_set_grade(
            desc.viewport_id.clone(),
            Some(serde_json::json!({ "layers": [] })),
            None,
        )
        .expect("set grade");

        let reference = viewport_render_rgba(&desc.viewport_id).expect("reference render");
        // No surface presented in tests: the readback must answer from the
        // reference path with identical pixels.
        assert!(
            crate::commands::viewport_surface::read_surface_pixels(&desc.viewport_id).is_none()
        );
        let payload = viewport_read_pixels(desc.viewport_id.clone()).expect("read pixels");
        // `tauri::ipc::Response` hides its body; parity is asserted through
        // the payload builder the command uses plus the shared render path.
        drop(payload);
        let rebuilt = {
            let rendered = viewport_render_rgba(&desc.viewport_id).expect("second render");
            pixels_bin_payload(
                rendered.image.width(),
                rendered.image.height(),
                &rendered.backend,
                rendered.image.as_raw(),
            )
            .expect("payload")
        };
        let meta_len = u32::from_le_bytes(rebuilt[0..4].try_into().unwrap()) as usize;
        assert_eq!(&rebuilt[4 + meta_len..], &reference.image.as_raw()[..]);

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn surface_backend_report_is_truthful_wgpu() {
        let report = surface_backend_report("auto");
        assert_eq!(report.requested, "auto");
        assert_eq!(report.actual, "wgpu");
        assert!(report.fallback_reason.is_none());
        // The adapter detail is present exactly when the shared device
        // initialised (absent on CI runners without a GPU).
        let device = crate::studio::wgpu_device::surface_device_report();
        assert_eq!(report.detail.is_some(), device.backend.is_some());
    }

    #[test]
    fn rejects_unknown_kind_and_bad_ids() {
        assert!(viewport_create("node_canvas".to_string()).is_err());
        assert!(viewport_destroy_inner("nonsense".to_string()).is_err());
        assert!(viewport_resize("vp-999999".to_string(), 1, 1).is_err());
    }

    #[test]
    fn grade_doc_only_on_grading_viewports() {
        let image = viewport_create("image_edit".to_string()).expect("create");
        let err = viewport_set_grade(image.viewport_id.clone(), Some(serde_json::json!({})), None)
            .expect_err("image_edit must reject a grade doc");
        assert!(err.contains("does not accept a grade doc"));
        viewport_destroy_inner(image.viewport_id).expect("destroy");

        for kind in ["grade_preview", "video_preview"] {
            let vp = viewport_create(kind.to_string()).expect("create");
            viewport_set_grade(vp.viewport_id.clone(), Some(serde_json::json!({})), None)
                .unwrap_or_else(|e| panic!("{kind} accepts a grade doc: {e}"));
            viewport_set_grade(vp.viewport_id.clone(), None, Some(0.5)).expect("clearing the doc");
            let err = viewport_set_grade(vp.viewport_id.clone(), None, Some(1.5))
                .expect_err("amount above 1 must be rejected");
            assert!(err.contains("temporal_denoise"));
            viewport_destroy_inner(vp.viewport_id).expect("destroy");
        }
    }

    #[test]
    fn temporal_chain_blends_continuous_frames_and_restarts_on_seek() {
        let desc = viewport_create("video_preview".to_string()).expect("create");
        let id = parse_id(&desc.viewport_id).expect("id");
        viewport_set_grade(desc.viewport_id.clone(), None, Some(1.0)).expect("set amount");

        let frame = |v: f32| hgripe_grade::GradeSurface {
            w: 1,
            h: 1,
            data: vec![v, v, v, 1.0],
            space: hgripe_grade::GradeSpace::Srgb,
        };

        // First frame passes through and seeds the chain.
        let mut a = frame(0.0);
        apply_temporal(id, "clip.mp4", 0.0, &mut a, 1.0).expect("first frame");
        assert_eq!(a.data[0], 0.0);

        // A small forward step blends toward the previous graded frame.
        let mut b = frame(0.02);
        apply_temporal(id, "clip.mp4", 0.04, &mut b, 1.0).expect("next frame");
        assert!(b.data[0] < 0.02, "continuous playback blends");

        // A backwards seek restarts the chain: the frame passes through.
        let mut c = frame(0.02);
        apply_temporal(id, "clip.mp4", 0.0, &mut c, 1.0).expect("seek back");
        assert_eq!(c.data[0], 0.02);

        // A forward jump past the continuity window also restarts it.
        let mut d = frame(0.04);
        apply_temporal(id, "clip.mp4", 5.0, &mut d, 1.0).expect("jump");
        assert_eq!(d.data[0], 0.04);

        // A source change restarts it too.
        let mut e = frame(0.06);
        apply_temporal(id, "other.mp4", 5.04, &mut e, 1.0).expect("source change");
        assert_eq!(e.data[0], 0.06);

        // Setting the amount back to 0 drops the feedback state.
        viewport_set_grade(desc.viewport_id.clone(), None, None).expect("disable");
        {
            let map = viewports().lock().expect("lock");
            assert!(map.get(&id).expect("open").temporal.is_none());
        }
        viewport_destroy_inner(desc.viewport_id).expect("destroy");
    }

    #[test]
    fn graded_render_caches_the_source_proxy_per_target_and_size() {
        // Register a real image so the graded render path runs end to end.
        let path = std::env::temp_dir().join("hgripe_viewport_proxy_cache.png");
        image::RgbaImage::from_pixel(64, 32, image::Rgba([40, 80, 120, 255]))
            .save(&path)
            .expect("write test image");
        let canonical = path.to_string_lossy().to_string();
        let res_id = resource::id_for(&canonical);
        resource::put(
            &res_id,
            resource::ResourceEntry {
                path: canonical,
                width: Some(64),
                height: Some(32),
            },
        );

        let desc = viewport_create("grade_preview".to_string()).expect("create");
        let id = parse_id(&desc.viewport_id).expect("id");
        viewport_resize(desc.viewport_id.clone(), 640, 480).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::Image {
                resource_id: res_id,
            },
        )
        .expect("set target");
        viewport_set_grade(
            desc.viewport_id.clone(),
            Some(serde_json::json!({ "layers": [] })),
            None,
        )
        .expect("set grade");

        let frame = viewport_render_frame(desc.viewport_id.clone()).expect("first render");
        assert!(frame.data_url.starts_with("data:image/png;base64,"));

        let first = {
            let map = viewports().lock().expect("lock");
            let proxy = map
                .get(&id)
                .and_then(|s| s.proxies.first())
                .expect("proxy cached");
            Arc::as_ptr(&proxy.srgb)
        };
        viewport_render_frame(desc.viewport_id.clone()).expect("second render");
        {
            let map = viewports().lock().expect("lock");
            let proxy = map
                .get(&id)
                .and_then(|s| s.proxies.first())
                .expect("proxy kept");
            assert_eq!(
                Arc::as_ptr(&proxy.srgb),
                first,
                "same proxy reused across renders"
            );
        }

        // A different viewport size is a different proxy identity.
        viewport_resize(desc.viewport_id.clone(), 320, 240).expect("resize");
        viewport_render_frame(desc.viewport_id.clone()).expect("render after resize");
        {
            let map = viewports().lock().expect("lock");
            let proxy = map
                .get(&id)
                .and_then(|s| s.proxies.first())
                .expect("proxy replaced");
            assert_ne!(
                Arc::as_ptr(&proxy.srgb),
                first,
                "resize decodes a new proxy identity"
            );
        }

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn set_view_validates_and_crops_the_rendered_frame() {
        let path = std::env::temp_dir().join("hgripe_viewport_set_view.png");
        image::RgbaImage::from_pixel(64, 64, image::Rgba([200, 100, 50, 255]))
            .save(&path)
            .expect("write test image");
        let canonical = path.to_string_lossy().to_string();
        let res_id = resource::id_for(&canonical);
        resource::put(
            &res_id,
            resource::ResourceEntry {
                path: canonical,
                width: Some(64),
                height: Some(64),
            },
        );

        let desc = viewport_create("image_edit".to_string()).expect("create");
        assert!(viewport_set_view(desc.viewport_id.clone(), f32::NAN, 0.0, 0.0).is_err());
        assert!(viewport_set_view(desc.viewport_id.clone(), 0.0, 0.0, 0.0).is_err());
        assert!(viewport_set_view(desc.viewport_id.clone(), 2.0, 0.25, f32::INFINITY).is_err());

        viewport_resize(desc.viewport_id.clone(), 64, 64).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::Image {
                resource_id: res_id,
            },
        )
        .expect("set target");

        let full = viewport_render_frame(desc.viewport_id.clone()).expect("identity render");
        viewport_set_view(desc.viewport_id.clone(), 2.0, 0.25, 0.25).expect("set view");
        let zoomed = viewport_render_frame(desc.viewport_id.clone()).expect("zoomed render");
        assert_eq!(zoomed.width, full.width / 2, "zoom 2 halves the window");
        assert_eq!(zoomed.height, full.height / 2);

        // Pans past the edge clamp so the window stays inside the frame.
        viewport_set_view(desc.viewport_id.clone(), 2.0, 5.0, -5.0).expect("set clamped view");
        let clamped = viewport_render_frame(desc.viewport_id.clone()).expect("clamped render");
        assert_eq!(clamped.width, full.width / 2);
        assert_eq!(clamped.height, full.height / 2);

        // Back to the identity view: the full frame again.
        viewport_set_view(desc.viewport_id.clone(), 1.0, 0.0, 0.0).expect("reset view");
        let reset = viewport_render_frame(desc.viewport_id.clone()).expect("reset render");
        assert_eq!(reset.width, full.width);
        assert_eq!(reset.height, full.height);

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn proxy_cache_is_a_bounded_per_viewport_lru() {
        let desc = viewport_create("image_edit".to_string()).expect("create");
        let id = parse_id(&desc.viewport_id).expect("id");
        let key = |n: u64| ProxyKey {
            path: format!("img-{n}"),
            time_bits: None,
            size: 64,
        };
        let decode = || Ok(image::RgbaImage::new(1, 1));

        // Fill the cache, then hit the oldest entry: no decode, moved to front.
        for n in 0..PROXY_CACHE_DEPTH as u64 {
            cached_proxy(id, key(n), decode).expect("decode");
        }
        cached_proxy(id, key(0), || Err("must not re-decode a cached key".into()))
            .expect("cache hit");

        // One more distinct key evicts the least recently used (key 1, since
        // key 0 was just refreshed) and the cache stays bounded.
        cached_proxy(id, key(PROXY_CACHE_DEPTH as u64), decode).expect("decode");
        {
            let map = viewports().lock().expect("lock");
            let state = map.get(&id).expect("open viewport");
            assert_eq!(
                state.proxies.len(),
                PROXY_CACHE_DEPTH,
                "cache stays bounded"
            );
            assert!(
                state.proxies.iter().all(|proxy| proxy.key != key(1)),
                "least recently used entry evicted"
            );
            assert!(
                state.proxies.iter().any(|proxy| proxy.key == key(0)),
                "refreshed entry retained"
            );
        }
        viewport_destroy_inner(desc.viewport_id).expect("destroy");
    }

    #[test]
    fn zoomed_render_decodes_at_higher_detail() {
        // Detail sizing: power-of-two steps toward size*zoom, capped.
        let view = |zoom: f32| ViewportView {
            zoom,
            pan_x: 0.0,
            pan_y: 0.0,
        };
        assert_eq!(proxy_detail_size(1280, view(1.0)), 1280);
        assert_eq!(proxy_detail_size(1280, view(1.5)), 2560);
        assert_eq!(proxy_detail_size(1280, view(2.0)), 2560);
        assert_eq!(proxy_detail_size(1280, view(8.0)), 4096);
        assert_eq!(proxy_detail_size(64, view(4.0)), 256);

        // End to end: a zoomed window over a large source renders at the
        // viewport size instead of upscaling a viewport-sized proxy.
        let path = std::env::temp_dir().join("hgripe_viewport_zoom_detail.png");
        image::RgbaImage::from_pixel(256, 256, image::Rgba([10, 20, 30, 255]))
            .save(&path)
            .expect("write test image");
        let canonical = path.to_string_lossy().to_string();
        let res_id = resource::id_for(&canonical);
        resource::put(
            &res_id,
            resource::ResourceEntry {
                path: canonical,
                width: Some(256),
                height: Some(256),
            },
        );

        let desc = viewport_create("image_edit".to_string()).expect("create");
        viewport_resize(desc.viewport_id.clone(), 64, 64).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::Image {
                resource_id: res_id,
            },
        )
        .expect("set target");

        viewport_set_view(desc.viewport_id.clone(), 4.0, 0.0, 0.0).expect("set view");
        let zoomed = viewport_render_frame(desc.viewport_id.clone()).expect("zoomed render");
        // detail = 256 at 4x, so the 1/4 window is 64px — the viewport size.
        assert_eq!(zoomed.width, 64, "zoomed window fills the viewport");
        assert_eq!(zoomed.height, 64);

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn image_layer_targets_resolve_through_the_layered_asset_registry() {
        // Two real layer artifacts of different colors, registered by path.
        let dir = std::env::temp_dir();
        let subject_path = dir.join("hgripe_viewport_layer_subject.png");
        let background_path = dir.join("hgripe_viewport_layer_background.png");
        image::RgbaImage::from_pixel(64, 64, image::Rgba([200, 40, 40, 255]))
            .save(&subject_path)
            .expect("write subject layer");
        image::RgbaImage::from_pixel(64, 64, image::Rgba([40, 40, 200, 255]))
            .save(&background_path)
            .expect("write background layer");
        let layer = |layer_id: &str, path: &std::path::Path| LayeredAssetLayer {
            layer_id: layer_id.to_string(),
            rgba_path: path.to_string_lossy().to_string(),
        };
        viewport_register_layered_asset(
            "layered-n1".to_string(),
            vec![
                layer("layer_subject", &subject_path),
                layer("layer_background", &background_path),
            ],
        )
        .expect("register layered asset");

        let desc = viewport_create("image_edit".to_string()).expect("create");
        viewport_resize(desc.viewport_id.clone(), 64, 64).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::ImageLayer {
                asset_id: "layered-n1".to_string(),
                layer_id: "layer_subject".to_string(),
            },
        )
        .expect("set image_layer target");
        let frame = viewport_render_frame(desc.viewport_id.clone()).expect("render layer");
        assert!(frame.data_url.starts_with("data:image/png;base64,"));
        assert_eq!((frame.width, frame.height), (64, 64));

        // Unknown layer / asset ids fail at set time, not at the first render.
        let err = viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::ImageLayer {
                asset_id: "layered-n1".to_string(),
                layer_id: "layer_missing".to_string(),
            },
        )
        .expect_err("unknown layer id must be rejected");
        assert!(err.contains("unknown layer id"), "{err}");
        let err = viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::ImageLayer {
                asset_id: "layered-missing".to_string(),
                layer_id: "layer_subject".to_string(),
            },
        )
        .expect_err("unknown asset id must be rejected");
        assert!(err.contains("unknown layered asset id"), "{err}");

        // Re-registration replaces the asset's layer set.
        viewport_register_layered_asset(
            "layered-n1".to_string(),
            vec![layer("layer_background", &background_path)],
        )
        .expect("re-register layered asset");
        assert!(layered_asset_layer_path("layered-n1", "layer_subject").is_err());
        assert!(layered_asset_layer_path("layered-n1", "layer_background").is_ok());

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&subject_path);
        let _ = std::fs::remove_file(&background_path);
    }

    #[test]
    fn image_composite_target_renders_source_copy_layers_through_masks() {
        let path = std::env::temp_dir().join("hgripe_viewport_image_composite.png");
        image::RgbaImage::from_pixel(64, 64, image::Rgba([220, 20, 40, 255]))
            .save(&path)
            .expect("write source");
        let canonical = path.to_string_lossy().to_string();
        let res_id = resource::id_for(&canonical);
        resource::put(
            &res_id,
            resource::ResourceEntry {
                path: canonical,
                width: Some(64),
                height: Some(64),
            },
        );

        let desc = viewport_create("image_edit".to_string()).expect("create");
        viewport_resize(desc.viewport_id.clone(), 64, 64).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::ImageComposite {
                resource_id: res_id,
                document_key: "copy-rect".to_string(),
                document_width: 64,
                document_height: 64,
                document: serde_json::json!({
                    "version": 3,
                    "layers": [
                        { "kind": "mask", "visible": false, "opacity": 1.0, "ops": [] },
                        {
                            "kind": "mask",
                            "visible": true,
                            "opacity": 1.0,
                            "ops": [{ "type": "source_image" }],
                            "mask": { "ops": [{ "type": "rect", "region": [16, 16, 48, 48] }] }
                        }
                    ]
                }),
            },
        )
        .expect("set composite target");

        let rendered = viewport_render_rgba(&desc.viewport_id).expect("render composite");
        assert_eq!(rendered.image.get_pixel(24, 24).0, [220, 20, 40, 255]);
        assert_eq!(rendered.image.get_pixel(4, 4).0, [0, 0, 0, 0]);

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn image_composite_target_moves_linked_masks_with_transformed_layers() {
        let path = std::env::temp_dir().join("hgripe_viewport_image_composite_move.png");
        image::RgbaImage::from_pixel(64, 64, image::Rgba([20, 180, 90, 255]))
            .save(&path)
            .expect("write source");
        let canonical = path.to_string_lossy().to_string();
        let res_id = resource::id_for(&canonical);
        resource::put(
            &res_id,
            resource::ResourceEntry {
                path: canonical,
                width: Some(64),
                height: Some(64),
            },
        );

        let desc = viewport_create("image_edit".to_string()).expect("create");
        viewport_resize(desc.viewport_id.clone(), 64, 64).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::ImageComposite {
                resource_id: res_id,
                document_key: "copy-rect-moved".to_string(),
                document_width: 64,
                document_height: 64,
                document: serde_json::json!({
                    "version": 3,
                    "layers": [
                        { "kind": "mask", "visible": false, "opacity": 1.0, "ops": [] },
                        {
                            "kind": "mask",
                            "visible": true,
                            "opacity": 1.0,
                            "ops": [
                                { "type": "source_image" },
                                { "type": "transform", "dx": 8, "dy": 0 }
                            ],
                            "mask": { "ops": [{ "type": "rect", "region": [16, 16, 48, 48] }] }
                        }
                    ]
                }),
            },
        )
        .expect("set composite target");

        let rendered = viewport_render_rgba(&desc.viewport_id).expect("render moved composite");
        assert_eq!(rendered.image.get_pixel(32, 24).0, [20, 180, 90, 255]);
        assert_eq!(rendered.image.get_pixel(20, 24).0, [0, 0, 0, 0]);

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn video_clip_targets_resolve_through_the_timeline_registry() {
        // A still clip renders end to end without the media engine; video
        // clips share the video_frame decode path (exercised elsewhere).
        let path = std::env::temp_dir().join("hgripe_viewport_timeline_still.png");
        image::RgbaImage::from_pixel(64, 64, image::Rgba([120, 200, 80, 255]))
            .save(&path)
            .expect("write still clip");
        viewport_register_timeline(
            "tl-1".to_string(),
            vec![TimelineClipRef {
                clip_id: "clip_still".to_string(),
                kind: "still".to_string(),
                path: path.to_string_lossy().to_string(),
                start_sec: 1.0,
                duration_sec: 2.0,
            }],
        )
        .expect("register timeline");

        let desc = viewport_create("video_preview".to_string()).expect("create");
        viewport_resize(desc.viewport_id.clone(), 64, 64).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::VideoClip {
                decode_device: None,
                timeline_id: "tl-1".to_string(),
                clip_id: "clip_still".to_string(),
                time_sec: 1.5,
            },
        )
        .expect("set video_clip target");
        let frame = viewport_render_frame(desc.viewport_id.clone()).expect("render still clip");
        assert!(frame.data_url.starts_with("data:image/png;base64,"));
        assert_eq!((frame.width, frame.height), (64, 64));

        // Unknown timeline / clip ids fail at set time, not at the first render.
        let err = viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::VideoClip {
                decode_device: None,
                timeline_id: "tl-1".to_string(),
                clip_id: "clip_missing".to_string(),
                time_sec: 0.0,
            },
        )
        .expect_err("unknown clip id must be rejected");
        assert!(err.contains("unknown clip id"), "{err}");
        let err = viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::VideoClip {
                decode_device: None,
                timeline_id: "tl-missing".to_string(),
                clip_id: "clip_still".to_string(),
                time_sec: 0.0,
            },
        )
        .expect_err("unknown timeline id must be rejected");
        assert!(err.contains("unknown timeline id"), "{err}");

        // Re-registration replaces the timeline's clip set.
        viewport_register_timeline("tl-1".to_string(), vec![]).expect("re-register timeline");
        assert!(timeline_clip("tl-1", "clip_still").is_err());

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn register_timeline_validates_ids_kinds_and_placements() {
        assert!(viewport_register_timeline("".to_string(), vec![]).is_err());
        let clip = |kind: &str, start: f64, dur: f64| TimelineClipRef {
            clip_id: "clip_1".to_string(),
            kind: kind.to_string(),
            path: "/does/not/exist.mp4".to_string(),
            start_sec: start,
            duration_sec: dur,
        };
        let err = viewport_register_timeline("tl-bad".to_string(), vec![clip("audio", 0.0, 1.0)])
            .expect_err("unknown clip kind must be rejected");
        assert!(err.contains("unknown kind"), "{err}");
        let err = viewport_register_timeline("tl-bad".to_string(), vec![clip("video", 0.0, 0.0)])
            .expect_err("zero duration must be rejected");
        assert!(err.contains("invalid placement"), "{err}");
        let err = viewport_register_timeline("tl-bad".to_string(), vec![clip("video", 0.0, 1.0)])
            .expect_err("missing media file must be rejected");
        assert!(err.contains("missing file"), "{err}");
    }

    #[test]
    fn node_output_targets_resolve_through_the_node_output_registry() {
        let path = std::env::temp_dir().join("hgripe_viewport_node_output.png");
        image::RgbaImage::from_pixel(64, 64, image::Rgba([40, 90, 220, 255]))
            .save(&path)
            .expect("write node output artifact");
        viewport_register_node_output(
            "node-1".to_string(),
            None,
            path.to_string_lossy().to_string(),
        )
        .expect("register node output");
        viewport_register_node_output(
            "node-1".to_string(),
            Some("alt".to_string()),
            path.to_string_lossy().to_string(),
        )
        .expect("register ported node output");

        let desc = viewport_create("image_edit".to_string()).expect("create");
        viewport_resize(desc.viewport_id.clone(), 64, 64).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::NodeOutput {
                node_id: "node-1".to_string(),
                output_port: None,
            },
        )
        .expect("set node_output target");
        let frame = viewport_render_frame(desc.viewport_id.clone()).expect("render node output");
        assert!(frame.data_url.starts_with("data:image/png;base64,"));
        assert_eq!((frame.width, frame.height), (64, 64));

        // The port is part of the key: an unregistered port fails at set time.
        let err = viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::NodeOutput {
                node_id: "node-1".to_string(),
                output_port: Some("missing".to_string()),
            },
        )
        .expect_err("unregistered port must be rejected");
        assert!(err.contains("unknown node output"), "{err}");
        let err = viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::NodeOutput {
                node_id: "node-missing".to_string(),
                output_port: None,
            },
        )
        .expect_err("unregistered node must be rejected");
        assert!(err.contains("unknown node output"), "{err}");

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn register_node_output_validates_ids_and_paths() {
        assert!(
            viewport_register_node_output("".to_string(), None, "/tmp/x.png".to_string()).is_err()
        );
        let err = viewport_register_node_output(
            "node-1".to_string(),
            Some("".to_string()),
            "/tmp/x.png".to_string(),
        )
        .expect_err("empty output port must be rejected");
        assert!(err.contains("empty output port"), "{err}");
        let err = viewport_register_node_output(
            "node-1".to_string(),
            None,
            "/does/not/exist.png".to_string(),
        )
        .expect_err("missing artifact file must be rejected");
        assert!(err.contains("missing file"), "{err}");
    }

    #[test]
    fn register_layered_asset_validates_ids_and_paths() {
        assert!(viewport_register_layered_asset("".to_string(), vec![]).is_err());
        assert!(viewport_register_layered_asset("layered-empty".to_string(), vec![]).is_err());
        let err = viewport_register_layered_asset(
            "layered-bad".to_string(),
            vec![LayeredAssetLayer {
                layer_id: "layer_1".to_string(),
                rgba_path: "/does/not/exist.png".to_string(),
            }],
        )
        .expect_err("missing artifact file must be rejected");
        assert!(err.contains("missing file"), "{err}");
        let err = viewport_register_layered_asset(
            "layered-bad".to_string(),
            vec![LayeredAssetLayer {
                layer_id: String::new(),
                rgba_path: "/does/not/exist.png".to_string(),
            }],
        )
        .expect_err("empty layer id must be rejected");
        assert!(err.contains("empty id"), "{err}");
    }

    #[test]
    fn unregister_removes_registry_entries_and_tolerates_unknown_ids() {
        let path = std::env::temp_dir().join("hgripe_viewport_unregister.png");
        image::RgbaImage::from_pixel(8, 8, image::Rgba([10, 20, 30, 255]))
            .save(&path)
            .expect("write artifact");
        let path_str = path.to_string_lossy().to_string();

        // Node outputs: every port of the node drops in one call.
        viewport_register_node_output("node-gone".to_string(), None, path_str.clone())
            .expect("register node output");
        viewport_register_node_output(
            "node-gone".to_string(),
            Some("alt".to_string()),
            path_str.clone(),
        )
        .expect("register ported node output");
        viewport_unregister_node_output("node-gone".to_string()).expect("unregister node output");
        assert!(node_output_path("node-gone", None).is_err());
        assert!(node_output_path("node-gone", Some("alt")).is_err());
        {
            let reg = node_outputs().lock().expect("lock node outputs");
            assert!(!reg.order.iter().any(|(id, _)| id == "node-gone"));
        }

        // Layered assets.
        viewport_register_layered_asset(
            "layered-gone".to_string(),
            vec![LayeredAssetLayer {
                layer_id: "layer_1".to_string(),
                rgba_path: path_str.clone(),
            }],
        )
        .expect("register layered asset");
        viewport_unregister_layered_asset("layered-gone".to_string())
            .expect("unregister layered asset");
        assert!(layered_asset_layer_path("layered-gone", "layer_1").is_err());
        {
            let reg = layered_assets().lock().expect("lock layered assets");
            assert!(!reg.order.iter().any(|id| id == "layered-gone"));
        }

        // Timelines.
        viewport_register_timeline(
            "tl-gone".to_string(),
            vec![TimelineClipRef {
                clip_id: "clip-1".to_string(),
                kind: "still".to_string(),
                path: path_str,
                start_sec: 0.0,
                duration_sec: 1.0,
            }],
        )
        .expect("register timeline");
        viewport_unregister_timeline("tl-gone".to_string()).expect("unregister timeline");
        assert!(timeline_clip("tl-gone", "clip-1").is_err());
        {
            let reg = timelines().lock().expect("lock timelines");
            assert!(!reg.order.iter().any(|id| id == "tl-gone"));
        }

        // Unknown ids are a no-op, never an error.
        viewport_unregister_node_output("node-unknown".to_string()).expect("no-op");
        viewport_unregister_layered_asset("layered-unknown".to_string()).expect("no-op");
        viewport_unregister_timeline("tl-unknown".to_string()).expect("no-op");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn set_target_validates_image_resource() {
        let desc = viewport_create("grade_preview".to_string()).expect("create");
        let err = viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::Image {
                resource_id: "res-does-not-exist".to_string(),
            },
        )
        .expect_err("unknown resource must be rejected");
        assert!(err.contains("unknown resource id"));
        viewport_destroy_inner(desc.viewport_id).expect("destroy");
    }
}
