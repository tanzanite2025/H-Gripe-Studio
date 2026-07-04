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
/// only the grade kernel over this proxy. Bounded by construction — one proxy
/// per viewport, viewports are capped at [`MAX_VIEWPORTS`].
struct SourceProxy {
    key: ProxyKey,
    srgb: Arc<RgbaImage>,
}

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

struct ViewportState {
    kind: String,
    target: Option<ViewportTarget>,
    width: u32,
    height: u32,
    /// Grade document applied at render time (grade_preview viewports); the
    /// doc is parameters only — pixels are resolved through the target.
    grade_doc: Option<Value>,
    view: ViewportView,
    proxy: Option<SourceProxy>,
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
/// still open) so the next parameter-only render skips the decode. The
/// registry lock is never held across a decode.
fn cached_proxy(
    id: u64,
    key: ProxyKey,
    decode: impl FnOnce() -> Result<RgbaImage, String>,
) -> Result<Arc<RgbaImage>, String> {
    {
        let map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        if let Some(proxy) = map.get(&id).and_then(|state| state.proxy.as_ref()) {
            if proxy.key == key {
                return Ok(proxy.srgb.clone());
            }
        }
    }
    let srgb = Arc::new(decode()?);
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    if let Some(state) = map.get_mut(&id) {
        state.proxy = Some(SourceProxy {
            key,
            srgb: srgb.clone(),
        });
    }
    Ok(srgb)
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
            proxy: None,
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
    if let ViewportTarget::Image { resource_id } | ViewportTarget::VideoFrame { resource_id, .. } =
        &target
    {
        if resource::get(resource_id).is_none() {
            return Err(format!("unknown resource id: {resource_id}"));
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
            let size = width.max(height).clamp(64, 2048);
            if grade_doc.is_some() || !view.is_identity() {
                // Graded and/or viewed frame: run the grading kernel (identity
                // when no doc is set) over the view window of the target's
                // sRGB proxy. The proxy is cached on the viewport, so a slider
                // drag or a pan/zoom tick re-runs only crop + kernel.
                let doc = parse_grade_doc(grade_doc.as_ref())?;
                let key = ProxyKey {
                    path: entry.path.clone(),
                    time_bits: None,
                    size,
                };
                let proxy = cached_proxy(id, key, || {
                    load_image_srgb_proxy(std::path::Path::new(&entry.path), size)
                })?;
                let source = if view.is_identity() {
                    None
                } else {
                    Some(crop_view(&proxy, view))
                };
                let graded =
                    grade_srgb_proxy(source.as_ref().unwrap_or(&proxy), &doc, Instant::now())?;
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
            // CPU placeholder transport: reuse the cached thumbnail pipeline at
            // the viewport's size (bounded so a huge surface cannot request a
            // full decode through this path).
            let thumb = generate_thumbnail_inner(&entry.path, size, None)?;
            Ok(ViewportFrame {
                data_url: thumb.data_url,
                width: thumb.width,
                height: thumb.height,
                backend: cpu_backend(),
            })
        }
        #[cfg(feature = "native-ffmpeg")]
        ViewportTarget::VideoFrame {
            resource_id,
            time_sec,
        } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            let size = width.max(height).clamp(64, 2048);
            if grade_doc.is_some() || !view.is_identity() {
                // Graded and/or viewed frame: decode through the native media
                // engine and run the grading kernel (identity when no doc is
                // set) over the view window of its sRGB proxy. The decoded
                // frame is cached on the viewport keyed by path + timestamp +
                // size, so grading or panning a paused frame re-runs only
                // crop + kernel.
                let doc = parse_grade_doc(grade_doc.as_ref())?;
                let key = ProxyKey {
                    path: entry.path.clone(),
                    time_bits: Some(time_sec.to_bits()),
                    size,
                };
                let proxy = cached_proxy(id, key, || {
                    crate::studio::decode_video_srgb_proxy(
                        std::path::Path::new(&entry.path),
                        time_sec,
                        size,
                    )
                })?;
                let source = if view.is_identity() {
                    None
                } else {
                    Some(crop_view(&proxy, view))
                };
                let graded =
                    grade_srgb_proxy(source.as_ref().unwrap_or(&proxy), &doc, Instant::now())?;
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
            // Ungraded frame (program monitor / scrubbing): resolve through the
            // playback engine — dedicated decode thread, bounded warm frame
            // cache, and latest-wins coalescing so a burst of seeks decodes
            // only the newest — then present via the thumbnail pipeline.
            let poster_dir = crate::cache_subdir(".posters")?;
            let frame = crate::studio::video_engine::scrub_frame(
                &poster_dir,
                std::path::Path::new(&entry.path),
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
        #[cfg(not(feature = "native-ffmpeg"))]
        ViewportTarget::VideoFrame { .. } => {
            Err("video frame targets require the native media engine".to_string())
        }
        ViewportTarget::ImageLayer { .. }
        | ViewportTarget::VideoClip { .. }
        | ViewportTarget::NodeOutput { .. } => {
            Err("target kind not supported by the phase 1 transport".to_string())
        }
    }
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
                .and_then(|s| s.proxy.as_ref())
                .expect("proxy cached");
            Arc::as_ptr(&proxy.srgb)
        };
        viewport_render_frame(desc.viewport_id.clone()).expect("second render");
        {
            let map = viewports().lock().expect("lock");
            let proxy = map
                .get(&id)
                .and_then(|s| s.proxy.as_ref())
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
                .and_then(|s| s.proxy.as_ref())
                .expect("proxy replaced");
            assert_ne!(
                Arc::as_ptr(&proxy.srgb),
                first,
                "resize invalidates the proxy"
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
