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
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::thumbnails::generate_thumbnail_inner;
use crate::resource;
use crate::studio::grade_preview;

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

struct ViewportState {
    kind: String,
    target: Option<ViewportTarget>,
    width: u32,
    height: u32,
    /// Grade document applied at render time (grade_preview viewports); the
    /// doc is parameters only — pixels are resolved through the target.
    grade_doc: Option<Value>,
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

const VIEWPORT_KINDS: [&str; 3] = ["image_edit", "grade_preview", "video_preview"];

#[tauri::command]
pub(crate) fn viewport_create(kind: String) -> Result<ViewportDescriptor, String> {
    if !VIEWPORT_KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown viewport kind: {kind}"));
    }
    let mut map = viewports().lock().map_err(|_| "viewport registry poisoned")?;
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
        },
    );
    eprintln!("[viewport] created vp-{id} kind={kind} (open: {})", map.len());
    Ok(ViewportDescriptor {
        viewport_id: format!("vp-{id}"),
        kind,
        backend: cpu_backend(),
    })
}

#[tauri::command]
pub(crate) fn viewport_destroy(viewport_id: String) -> Result<(), String> {
    let id = parse_id(&viewport_id)?;
    let mut map = viewports().lock().map_err(|_| "viewport registry poisoned")?;
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
    let mut map = viewports().lock().map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    state.target = Some(target);
    Ok(())
}

#[tauri::command]
pub(crate) fn viewport_resize(viewport_id: String, width: u32, height: u32) -> Result<(), String> {
    let id = parse_id(&viewport_id)?;
    let mut map = viewports().lock().map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    state.width = width;
    state.height = height;
    Ok(())
}

/// Set (or clear) the grade document a grade_preview viewport applies at
/// render time. Parameter updates flow through viewport state — the target
/// reference and the transport stay untouched.
#[tauri::command]
pub(crate) fn viewport_set_grade(viewport_id: String, doc: Option<Value>) -> Result<(), String> {
    let id = parse_id(&viewport_id)?;
    let mut map = viewports().lock().map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    if state.kind != "grade_preview" {
        return Err(format!(
            "viewport {viewport_id} (kind={}) does not accept a grade doc",
            state.kind
        ));
    }
    state.grade_doc = doc;
    Ok(())
}

#[tauri::command]
pub(crate) fn viewport_render_frame(viewport_id: String) -> Result<ViewportFrame, String> {
    let id = parse_id(&viewport_id)?;
    let (target, width, height, grade_doc) = {
        let map = viewports().lock().map_err(|_| "viewport registry poisoned")?;
        let state = map
            .get(&id)
            .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
        (
            state.target.clone(),
            state.width,
            state.height,
            state.grade_doc.clone(),
        )
    };
    let target = target.ok_or_else(|| format!("viewport {viewport_id} has no target"))?;
    match target {
        ViewportTarget::Image { resource_id } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            let size = width.max(height).clamp(64, 2048);
            if let Some(doc) = grade_doc {
                // Graded frame: run the grading kernel over the target's sRGB
                // proxy at the viewport size.
                let graded = grade_preview(entry.path.clone(), doc, Some(size))?;
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
            // Decode the frame through the native media engine and run the
            // grading kernel over its sRGB proxy — the identity document when
            // no grade doc is set.
            let doc = grade_doc.unwrap_or(Value::Null);
            let graded = crate::studio::video_frame_grade_preview(
                entry.path.clone(),
                time_sec,
                doc,
                Some(size),
            )?;
            Ok(ViewportFrame {
                data_url: graded.data_url,
                width: graded.width,
                height: graded.height,
                backend: ViewportBackend {
                    requested: "auto".to_string(),
                    actual: graded.backend.to_string(),
                    fallback_reason: None,
                },
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
    fn grade_doc_only_on_grade_preview_viewports() {
        let image = viewport_create("image_edit".to_string()).expect("create");
        let err = viewport_set_grade(image.viewport_id.clone(), Some(serde_json::json!({})))
            .expect_err("image_edit must reject a grade doc");
        assert!(err.contains("does not accept a grade doc"));
        viewport_destroy(image.viewport_id).expect("destroy");

        let grade = viewport_create("grade_preview".to_string()).expect("create");
        viewport_set_grade(grade.viewport_id.clone(), Some(serde_json::json!({})))
            .expect("grade_preview accepts a grade doc");
        viewport_set_grade(grade.viewport_id.clone(), None).expect("clearing the doc");
        viewport_destroy(grade.viewport_id).expect("destroy");
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
