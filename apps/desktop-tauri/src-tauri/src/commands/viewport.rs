//! WGPU viewport host lifecycle (migration Phase 1, see
//! `docs/plans/active/WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`).
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::thumbnails::generate_thumbnail_inner;
use crate::resource;
use crate::studio::{grade_srgb_proxy, load_image_srgb_proxy, parse_grade_doc};

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
    VideoClip {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
        #[serde(rename = "timeSec")]
        time_sec: f64,
    },
    /// One decoded frame of a registered video file, addressed by resource
    /// reference + timestamp. The pre-timeline target for grading a raw video
    /// path; timeline clips address frames through [`Self::VideoClip`].
    VideoFrame {
        #[serde(rename = "resourceId")]
        resource_id: String,
        #[serde(rename = "timeSec")]
        time_sec: f64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

fn cpu_backend() -> ViewportBackend {
    ViewportBackend {
        requested: "auto".to_string(),
        actual: "cpu".to_string(),
        fallback_reason: Some("wgpu transport not implemented yet (phase 1)".to_string()),
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

/// Identity of a decoded source proxy: which pixels it holds and at what
/// size. Timestamps are compared through their bit pattern so the key can be
/// `Eq` without float fuzz.
#[derive(Clone, PartialEq, Eq)]
struct ProxyKey {
    path: String,
    time_bits: Option<u64>,
    size: u32,
}

/// The viewport's cached display-space source: decode + downscale happen once
/// per (target, size); parameter-only re-renders such as slider drags re-run
/// only the grade kernel over this proxy.
struct SourceProxy {
    key: ProxyKey,
    srgb: Arc<RgbaImage>,
}

/// Per-viewport proxy cache depth (Phase 4 bounded frame cache): scrubbing
/// back and forth across nearby timestamps — or flipping between a layer's
/// cutout and its mask — reuses recently decoded proxies instead of
/// re-decoding. Bounded by construction: at most this many proxies per
/// viewport, viewports capped at [`MAX_VIEWPORTS`].
const PROXY_CACHE_DEPTH: usize = 8;

/// Presentation view state (WGPU migration Phase 2): `zoom >= 1` selects a
/// window `1/zoom` the size of the source; `pan_x`/`pan_y` place the window's
/// top-left corner in normalized source coordinates and are clamped so the
/// window stays inside the frame. The identity view shows the whole source.
#[derive(Clone, Copy)]
struct ViewportView {
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
}

impl ViewportView {
    const IDENTITY: ViewportView = ViewportView {
        zoom: 1.0,
        pan_x: 0.0,
        pan_y: 0.0,
    };

    fn is_identity(self) -> bool {
        self.zoom <= 1.0 && self.pan_x == 0.0 && self.pan_y == 0.0
    }
}

/// Crop `srgb` to the view's window. Cheap relative to decode: the input is
/// the cached display-space proxy, so a pan/zoom tick re-crops the proxy
/// without touching the source file.
fn crop_view(srgb: &RgbaImage, view: ViewportView) -> RgbaImage {
    let (w, h) = srgb.dimensions();
    let zoom = view.zoom.max(1.0);
    let vw = ((w as f32 / zoom).round() as u32).clamp(1, w);
    let vh = ((h as f32 / zoom).round() as u32).clamp(1, h);
    let x = ((view.pan_x * w as f32).round() as i64).clamp(0, (w - vw) as i64) as u32;
    let y = ((view.pan_y * h as f32).round() as i64).clamp(0, (h - vh) as i64) as u32;
    image::imageops::crop_imm(srgb, x, y, vw, vh).to_image()
}

/// Proxy decode size for a view: zoomed views decode at a higher detail so
/// the `1/zoom` window still fills the viewport instead of upscaling a
/// viewport-sized proxy. Zoom is quantized to powers of two so consecutive
/// wheel ticks reuse the cached proxy, and the result is capped so a deep
/// zoom cannot request an unbounded decode. Decoders only ever downscale, so
/// small sources are unaffected.
fn proxy_detail_size(size: u32, view: ViewportView) -> u32 {
    const MAX_PROXY_DIM: u32 = 4096;
    let zoom = view.zoom.clamp(1.0, 8.0);
    let mut detail = size;
    while (detail as f32) < (size as f32) * zoom && detail < MAX_PROXY_DIM {
        detail = (detail * 2).min(MAX_PROXY_DIM);
    }
    detail
}

struct ViewportState {
    kind: String,
    target: Option<ViewportTarget>,
    width: u32,
    height: u32,
    /// Grade document applied at render time (grade_preview viewports); the
    /// doc is parameters only — pixels are resolved through the target.
    grade_doc: Option<Value>,
    view: ViewportView,
    /// Most-recently-used first, at most [`PROXY_CACHE_DEPTH`] entries.
    proxies: Vec<SourceProxy>,
}

static VIEWPORTS: OnceLock<Mutex<HashMap<u64, ViewportState>>> = OnceLock::new();
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

/// Fetch the viewport's cached source proxy for `key`, decoding through
/// `decode` on a miss and storing the result back onto the viewport (if it is
/// still open) so the next parameter-only render skips the decode. The cache
/// is a small per-viewport LRU ([`PROXY_CACHE_DEPTH`]); the registry lock is
/// never held across a decode.
fn cached_proxy(
    id: u64,
    key: ProxyKey,
    decode: impl FnOnce() -> Result<RgbaImage, String>,
) -> Result<Arc<RgbaImage>, String> {
    {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        if let Some(state) = map.get_mut(&id) {
            if let Some(pos) = state.proxies.iter().position(|proxy| proxy.key == key) {
                let hit = state.proxies.remove(pos);
                let srgb = hit.srgb.clone();
                state.proxies.insert(0, hit);
                return Ok(srgb);
            }
        }
    }
    let srgb = Arc::new(decode()?);
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    if let Some(state) = map.get_mut(&id) {
        state.proxies.retain(|proxy| proxy.key != key);
        state.proxies.insert(
            0,
            SourceProxy {
                key,
                srgb: srgb.clone(),
            },
        );
        state.proxies.truncate(PROXY_CACHE_DEPTH);
    }
    Ok(srgb)
}

/// Cap on registered layered assets. Entries are small (ids and paths), but
/// the registry lives for the whole app session; past the cap the oldest
/// registrations drop (FIFO) and are simply re-registered on the next open.
const MAX_LAYERED_ASSETS: usize = 256;

/// One registered layer artifact: the layer's flattened RGBA file, by path.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct LayeredAssetLayer {
    #[serde(rename = "layerId")]
    pub layer_id: String,
    #[serde(rename = "rgbaPath")]
    pub rgba_path: String,
}

struct LayeredAssetRegistry {
    /// asset id -> (layer id -> rgba path)
    map: HashMap<String, HashMap<String, String>>,
    /// Insertion order of asset ids, oldest first, for FIFO eviction.
    order: Vec<String>,
}

static LAYERED_ASSETS: OnceLock<Mutex<LayeredAssetRegistry>> = OnceLock::new();

fn layered_assets() -> &'static Mutex<LayeredAssetRegistry> {
    LAYERED_ASSETS.get_or_init(|| {
        Mutex::new(LayeredAssetRegistry {
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

fn layered_asset_layer_path(asset_id: &str, layer_id: &str) -> Result<String, String> {
    let reg = layered_assets()
        .lock()
        .map_err(|_| "layered asset registry poisoned")?;
    let layers = reg
        .map
        .get(asset_id)
        .ok_or_else(|| format!("unknown layered asset id: {asset_id}"))?;
    layers
        .get(layer_id)
        .cloned()
        .ok_or_else(|| format!("unknown layer id {layer_id} on layered asset {asset_id}"))
}

/// Register (or refresh) the layer artifacts of a layered asset so viewports
/// can resolve `image_layer` targets host-side, by reference. Layers are
/// registered by path — never pixels — mirroring the resource registry; a
/// re-registration after an edit replaces the asset's layer set.
#[tauri::command]
pub(crate) fn viewport_register_layered_asset(
    asset_id: String,
    layers: Vec<LayeredAssetLayer>,
) -> Result<(), String> {
    if asset_id.is_empty() {
        return Err("layered asset id must not be empty".to_string());
    }
    if layers.is_empty() {
        return Err(format!(
            "layered asset {asset_id} has no layers to register"
        ));
    }
    let mut set = HashMap::new();
    for layer in layers {
        if layer.layer_id.is_empty() {
            return Err(format!(
                "layered asset {asset_id} has a layer with an empty id"
            ));
        }
        if !std::path::Path::new(&layer.rgba_path).is_file() {
            return Err(format!(
                "layer {} of asset {asset_id} points at a missing file: {}",
                layer.layer_id, layer.rgba_path
            ));
        }
        set.insert(layer.layer_id, layer.rgba_path);
    }
    let mut reg = layered_assets()
        .lock()
        .map_err(|_| "layered asset registry poisoned")?;
    if reg.map.insert(asset_id.clone(), set).is_none() {
        reg.order.push(asset_id);
        while reg.map.len() > MAX_LAYERED_ASSETS {
            if reg.order.is_empty() {
                break;
            }
            let oldest = reg.order.remove(0);
            reg.map.remove(&oldest);
        }
    }
    Ok(())
}

/// Cap on registered timelines, bounded like the layered asset registry.
const MAX_TIMELINES: usize = 64;

/// One registered timeline clip: its media by path plus the placement that
/// maps timeline time to clip-local source time.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TimelineClipRef {
    #[serde(rename = "clipId")]
    pub clip_id: String,
    /// "video" (decode the frame at source time) or "still" (render the image).
    pub kind: String,
    pub path: String,
    #[serde(rename = "startSec")]
    pub start_sec: f64,
    #[serde(rename = "durationSec")]
    pub duration_sec: f64,
}

struct TimelineRegistry {
    /// timeline id -> (clip id -> clip)
    map: HashMap<String, HashMap<String, TimelineClipRef>>,
    /// Insertion order of timeline ids, oldest first, for FIFO eviction.
    order: Vec<String>,
}

static TIMELINES: OnceLock<Mutex<TimelineRegistry>> = OnceLock::new();

fn timelines() -> &'static Mutex<TimelineRegistry> {
    TIMELINES.get_or_init(|| {
        Mutex::new(TimelineRegistry {
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

fn timeline_clip(timeline_id: &str, clip_id: &str) -> Result<TimelineClipRef, String> {
    let reg = timelines()
        .lock()
        .map_err(|_| "timeline registry poisoned")?;
    let clips = reg
        .map
        .get(timeline_id)
        .ok_or_else(|| format!("unknown timeline id: {timeline_id}"))?;
    clips
        .get(clip_id)
        .cloned()
        .ok_or_else(|| format!("unknown clip id {clip_id} on timeline {timeline_id}"))
}

/// Register (or refresh) a timeline's clips so viewports can resolve
/// `video_clip` targets host-side, by reference. Clips register by media
/// path — never pixels — and a re-registration after an edit replaces the
/// timeline's clip set.
#[tauri::command]
pub(crate) fn viewport_register_timeline(
    timeline_id: String,
    clips: Vec<TimelineClipRef>,
) -> Result<(), String> {
    if timeline_id.is_empty() {
        return Err("timeline id must not be empty".to_string());
    }
    let mut set = HashMap::new();
    for clip in clips {
        if clip.clip_id.is_empty() {
            return Err(format!(
                "timeline {timeline_id} has a clip with an empty id"
            ));
        }
        if clip.kind != "video" && clip.kind != "still" {
            return Err(format!(
                "clip {} of timeline {timeline_id} has an unknown kind: {}",
                clip.clip_id, clip.kind
            ));
        }
        if !(clip.duration_sec > 0.0) || !clip.start_sec.is_finite() {
            return Err(format!(
                "clip {} of timeline {timeline_id} has an invalid placement",
                clip.clip_id
            ));
        }
        if !std::path::Path::new(&clip.path).is_file() {
            return Err(format!(
                "clip {} of timeline {timeline_id} points at a missing file: {}",
                clip.clip_id, clip.path
            ));
        }
        set.insert(clip.clip_id.clone(), clip);
    }
    let mut reg = timelines()
        .lock()
        .map_err(|_| "timeline registry poisoned")?;
    if reg.map.insert(timeline_id.clone(), set).is_none() {
        reg.order.push(timeline_id);
        while reg.map.len() > MAX_TIMELINES {
            if reg.order.is_empty() {
                break;
            }
            let oldest = reg.order.remove(0);
            reg.map.remove(&oldest);
        }
    }
    Ok(())
}

/// Cap on registered node outputs, bounded like the other target registries.
const MAX_NODE_OUTPUTS: usize = 256;

struct NodeOutputRegistry {
    /// (node id, output port) -> image artifact path.
    map: HashMap<(String, Option<String>), String>,
    /// Insertion order of keys, oldest first, for FIFO eviction.
    order: Vec<(String, Option<String>)>,
}

static NODE_OUTPUTS: OnceLock<Mutex<NodeOutputRegistry>> = OnceLock::new();

fn node_outputs() -> &'static Mutex<NodeOutputRegistry> {
    NODE_OUTPUTS.get_or_init(|| {
        Mutex::new(NodeOutputRegistry {
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

fn node_output_path(node_id: &str, output_port: Option<&str>) -> Result<String, String> {
    let reg = node_outputs()
        .lock()
        .map_err(|_| "node output registry poisoned")?;
    let key = (node_id.to_string(), output_port.map(str::to_string));
    reg.map.get(&key).cloned().ok_or_else(|| match output_port {
        Some(port) => format!("unknown node output: {node_id}:{port}"),
        None => format!("unknown node output: {node_id}"),
    })
}

/// Register (or refresh) one node output's image artifact so viewports can
/// resolve `node_output` targets host-side, by reference — the path, never
/// pixels. A re-registration after a re-run replaces the artifact path.
#[tauri::command]
pub(crate) fn viewport_register_node_output(
    node_id: String,
    output_port: Option<String>,
    path: String,
) -> Result<(), String> {
    if node_id.is_empty() {
        return Err("node id must not be empty".to_string());
    }
    if output_port.as_deref() == Some("") {
        return Err(format!("node {node_id} has an empty output port"));
    }
    if !std::path::Path::new(&path).is_file() {
        return Err(format!(
            "node output {node_id} points at a missing file: {path}"
        ));
    }
    let mut reg = node_outputs()
        .lock()
        .map_err(|_| "node output registry poisoned")?;
    let key = (node_id, output_port);
    if reg.map.insert(key.clone(), path).is_none() {
        reg.order.push(key);
        while reg.map.len() > MAX_NODE_OUTPUTS {
            if reg.order.is_empty() {
                break;
            }
            let oldest = reg.order.remove(0);
            reg.map.remove(&oldest);
        }
    }
    Ok(())
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
            view: ViewportView::IDENTITY,
            proxies: Vec::new(),
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
pub(crate) fn viewport_destroy(viewport_id: String) -> Result<(), String> {
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
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
        ViewportTarget::Image { resource_id } | ViewportTarget::VideoFrame { resource_id, .. } => {
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
/// transport stay untouched.
#[tauri::command]
pub(crate) fn viewport_set_grade(viewport_id: String, doc: Option<Value>) -> Result<(), String> {
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

#[tauri::command]
pub(crate) fn viewport_render_frame(viewport_id: String) -> Result<ViewportFrame, String> {
    let id = parse_id(&viewport_id)?;
    let (target, width, height, grade_doc, view) = {
        let map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        let state = map
            .get(&id)
            .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
        (
            state.target.clone(),
            state.width,
            state.height,
            state.grade_doc.clone(),
            state.view,
        )
    };
    let target = target.ok_or_else(|| format!("viewport {viewport_id} has no target"))?;
    match target {
        ViewportTarget::Image { resource_id } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            render_image_path(id, &entry.path, width, height, grade_doc, view)
        }
        ViewportTarget::ImageLayer { asset_id, layer_id } => {
            // Layer artifacts resolve through the layered asset registry —
            // the same reference-not-pixels contract as image resources.
            let path = layered_asset_layer_path(&asset_id, &layer_id)?;
            render_image_path(id, &path, width, height, grade_doc, view)
        }
        #[cfg(feature = "native-ffmpeg")]
        ViewportTarget::VideoFrame {
            resource_id,
            time_sec,
        } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            render_video_path(id, &entry.path, time_sec, width, height, grade_doc, view)
        }
        #[cfg(not(feature = "native-ffmpeg"))]
        ViewportTarget::VideoFrame { .. } => {
            Err("video frame targets require the native media engine".to_string())
        }
        ViewportTarget::VideoClip {
            timeline_id,
            clip_id,
            time_sec,
        } => {
            // Clips resolve through the timeline registry; the host maps the
            // timeline playhead to clip-local source time.
            let clip = timeline_clip(&timeline_id, &clip_id)?;
            if clip.kind == "still" {
                return render_image_path(id, &clip.path, width, height, grade_doc, view);
            }
            let source_time = (time_sec - clip.start_sec).clamp(0.0, clip.duration_sec);
            #[cfg(feature = "native-ffmpeg")]
            {
                render_video_path(id, &clip.path, source_time, width, height, grade_doc, view)
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
            render_image_path(id, &path, width, height, grade_doc, view)
        }
    }
}

/// Render one video source frame at the viewport's size, applying its grade
/// doc and view. Graded/viewed frames decode through the native media engine
/// with the proxy cached per viewport keyed by path + timestamp + size, so
/// grading or panning a paused frame re-runs only crop + kernel; ungraded
/// frames resolve through the playback engine — dedicated decode thread,
/// bounded warm frame cache, latest-wins coalescing — then present via the
/// thumbnail pipeline.
#[cfg(feature = "native-ffmpeg")]
fn render_video_path(
    id: u64,
    path: &str,
    time_sec: f64,
    width: u32,
    height: u32,
    grade_doc: Option<Value>,
    view: ViewportView,
) -> Result<ViewportFrame, String> {
    let size = width.max(height).clamp(64, 2048);
    if grade_doc.is_some() || !view.is_identity() {
        let doc = parse_grade_doc(grade_doc.as_ref())?;
        let detail = proxy_detail_size(size, view);
        let key = ProxyKey {
            path: path.to_string(),
            time_bits: Some(time_sec.to_bits()),
            size: detail,
        };
        let proxy = cached_proxy(id, key, || {
            crate::studio::decode_video_srgb_proxy(std::path::Path::new(path), time_sec, detail)
        })?;
        let source = if view.is_identity() {
            None
        } else {
            Some(crop_view(&proxy, view))
        };
        let graded = grade_srgb_proxy(source.as_ref().unwrap_or(&proxy), &doc, Instant::now())?;
        return Ok(ViewportFrame {
            data_url: graded.data_url,
            width: graded.width,
            height: graded.height,
            backend: ViewportBackend {
                requested: "auto".to_string(),
                actual: graded.backend.to_string(),
                fallback_reason: None,
            },
        });
    }
    let poster_dir = crate::cache_subdir(".posters")?;
    let frame = crate::studio::video_engine::scrub_frame(
        &poster_dir,
        std::path::Path::new(path),
        time_sec,
    )?;
    let thumb = generate_thumbnail_inner(&frame.to_string_lossy(), size, None)?;
    Ok(ViewportFrame {
        data_url: thumb.data_url,
        width: thumb.width,
        height: thumb.height,
        backend: cpu_backend(),
    })
}

/// Render one still-image source (an image resource or a layer artifact) at
/// the viewport's size, applying its grade doc and view. The decoded sRGB
/// proxy is cached on the viewport keyed by path + size, so a slider drag or
/// a pan/zoom tick re-runs only crop + kernel.
fn render_image_path(
    id: u64,
    path: &str,
    width: u32,
    height: u32,
    grade_doc: Option<Value>,
    view: ViewportView,
) -> Result<ViewportFrame, String> {
    let size = width.max(height).clamp(64, 2048);
    if grade_doc.is_some() || !view.is_identity() {
        // Graded and/or viewed frame: run the grading kernel (identity when
        // no doc is set) over the view window of the source's sRGB proxy.
        let doc = parse_grade_doc(grade_doc.as_ref())?;
        let detail = proxy_detail_size(size, view);
        let key = ProxyKey {
            path: path.to_string(),
            time_bits: None,
            size: detail,
        };
        let proxy = cached_proxy(id, key, || {
            load_image_srgb_proxy(std::path::Path::new(path), detail)
        })?;
        let source = if view.is_identity() {
            None
        } else {
            Some(crop_view(&proxy, view))
        };
        let graded = grade_srgb_proxy(source.as_ref().unwrap_or(&proxy), &doc, Instant::now())?;
        return Ok(ViewportFrame {
            data_url: graded.data_url,
            width: graded.width,
            height: graded.height,
            backend: ViewportBackend {
                requested: "auto".to_string(),
                actual: graded.backend.to_string(),
                fallback_reason: None,
            },
        });
    }
    // CPU placeholder transport: reuse the cached thumbnail pipeline at the
    // viewport's size (bounded so a huge surface cannot request a full decode
    // through this path).
    let thumb = generate_thumbnail_inner(path, size, None)?;
    Ok(ViewportFrame {
        data_url: thumb.data_url,
        width: thumb.width,
        height: thumb.height,
        backend: cpu_backend(),
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

        viewport_destroy(desc.viewport_id.clone()).expect("destroy");
        // Destroyed viewports are gone.
        assert!(viewport_resize(desc.viewport_id.clone(), 1, 1).is_err());
        assert!(viewport_destroy(desc.viewport_id).is_err());
    }

    #[test]
    fn rejects_unknown_kind_and_bad_ids() {
        assert!(viewport_create("node_canvas".to_string()).is_err());
        assert!(viewport_destroy("nonsense".to_string()).is_err());
        assert!(viewport_resize("vp-999999".to_string(), 1, 1).is_err());
    }

    #[test]
    fn grade_doc_only_on_grading_viewports() {
        let image = viewport_create("image_edit".to_string()).expect("create");
        let err = viewport_set_grade(image.viewport_id.clone(), Some(serde_json::json!({})))
            .expect_err("image_edit must reject a grade doc");
        assert!(err.contains("does not accept a grade doc"));
        viewport_destroy(image.viewport_id).expect("destroy");

        for kind in ["grade_preview", "video_preview"] {
            let vp = viewport_create(kind.to_string()).expect("create");
            viewport_set_grade(vp.viewport_id.clone(), Some(serde_json::json!({})))
                .unwrap_or_else(|e| panic!("{kind} accepts a grade doc: {e}"));
            viewport_set_grade(vp.viewport_id.clone(), None).expect("clearing the doc");
            viewport_destroy(vp.viewport_id).expect("destroy");
        }
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

        viewport_destroy(desc.viewport_id).expect("destroy");
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

        viewport_destroy(desc.viewport_id).expect("destroy");
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
        viewport_destroy(desc.viewport_id).expect("destroy");
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

        viewport_destroy(desc.viewport_id).expect("destroy");
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

        viewport_destroy(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&subject_path);
        let _ = std::fs::remove_file(&background_path);
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

        viewport_destroy(desc.viewport_id).expect("destroy");
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

        viewport_destroy(desc.viewport_id).expect("destroy");
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
        viewport_destroy(desc.viewport_id).expect("destroy");
    }
}
