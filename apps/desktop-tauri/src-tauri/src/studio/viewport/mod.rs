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

use std::sync::atomic::Ordering;

use serde_json::Value;

use crate::resource;
use crate::studio::{ClipPropsEvaluator, RetainedImageSceneKey};

mod registries;
pub(crate) use registries::*;
mod frame_io;
pub(crate) use frame_io::*;
mod overlays;
pub(crate) use overlays::*;
mod proxy_cache;
use proxy_cache::*;
mod render;
use render::*;
mod render_image;
use render_image::*;
mod retained_image_scene;
use retained_image_scene::*;
#[cfg(feature = "native-ffmpeg")]
mod render_video;
#[cfg(feature = "native-ffmpeg")]
use render_video::*;
mod state;
pub(crate) use state::*;
mod temporal;
use temporal::*;

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
            retained_image_scene: None,
            image_layer_presentation: None,
            retired_image_layer_transactions: Vec::new(),
            target_request_epoch: 0,
            content_generation: 1,
            render_generation: 1,
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
    let desired_scene_key = match &target {
        ViewportTarget::ImageComposite {
            resource_id,
            document_key,
            document_width,
            document_height,
            frame_x,
            frame_y,
            frame_width,
            frame_height,
            ..
        } => {
            if document_key.trim().is_empty() {
                return Err("image composite documentKey must not be empty".to_string());
            }
            if !frame_x.is_finite() || !frame_y.is_finite() {
                return Err("image composite frame origin must be finite".to_string());
            }
            let entry = resource::get(resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            Some(RetainedImageSceneKey::new(
                &entry.path,
                document_key,
                *document_width,
                *document_height,
                *frame_x,
                *frame_y,
                frame_width.unwrap_or(*document_width),
                frame_height.unwrap_or(*document_height),
            ))
        }
        _ => None,
    };
    let (request_epoch, existing_scene) = {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        let state = map
            .get_mut(&id)
            .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
        state.target_request_epoch = state.target_request_epoch.wrapping_add(1);
        let existing = desired_scene_key.as_ref().and_then(|key| {
            state
                .retained_image_scene
                .as_ref()
                .filter(|scene| scene.key() == key)
                .cloned()
        });
        (state.target_request_epoch, existing)
    };
    let prepared_scene = match (&target, existing_scene) {
        (ViewportTarget::ImageComposite { .. }, Some(scene)) => Some(scene),
        (
            ViewportTarget::ImageComposite {
                resource_id,
                document,
                document_key,
                document_width,
                document_height,
                frame_x,
                frame_y,
                frame_width,
                frame_height,
            },
            None,
        ) => {
            let entry = resource::get(resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            Some(build_retained_image_scene(
                id,
                &entry.path,
                document,
                document_key,
                *document_width,
                *document_height,
                *frame_x,
                *frame_y,
                frame_width.unwrap_or(*document_width),
                frame_height.unwrap_or(*document_height),
            )?)
        }
        _ => None,
    };
    {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        let state = map
            .get_mut(&id)
            .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
        if state.target_request_epoch != request_epoch {
            return Err("viewport target superseded by a newer target request".to_string());
        }
        let next_document_key = prepared_scene
            .as_ref()
            .map(|scene| scene.document_key().to_string());
        state.image_layer_presentation = state.image_layer_presentation.take().filter(|current| {
            next_document_key.as_deref() == Some(current.base_document_key.as_str())
        });
        if state.image_layer_presentation.is_none() {
            state.retired_image_layer_transactions.clear();
        }
        state.target = Some(target);
        state.retained_image_scene = prepared_scene;
        state.bump_content_generation();
        crate::commands::viewport_surface::invalidate_content(&viewport_id);
    }
    Ok(())
}

/// Build a replacement document revision while the previous complete scene
/// remains presented, then atomically swap the document payload and retained
/// nodes. The image resource and native backing texture keep their identity.
#[tauri::command]
pub(crate) async fn viewport_set_image_scene(
    viewport_id: String,
    scene: ViewportImageScene,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || viewport_set_image_scene_inner(viewport_id, scene))
        .await
        .map_err(|error| format!("viewport image scene worker failed: {error}"))?
}

fn viewport_set_image_scene_inner(
    viewport_id: String,
    scene: ViewportImageScene,
) -> Result<(), String> {
    scene.validate()?;
    let id = parse_id(&viewport_id)?;
    let (request_epoch, resource_id, source_path, existing_scene) = {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        let state = map
            .get_mut(&id)
            .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
        let resource_id = match state.target.as_ref() {
            Some(ViewportTarget::ImageComposite { resource_id, .. }) => resource_id.clone(),
            _ => {
                return Err(format!(
                    "viewport {viewport_id} has no image composite target"
                ));
            }
        };
        let source_path = resource::get(&resource_id)
            .ok_or_else(|| format!("unknown resource id: {resource_id}"))?
            .path;
        let key = RetainedImageSceneKey::new(
            &source_path,
            &scene.document_key,
            scene.document_width,
            scene.document_height,
            scene.frame_x,
            scene.frame_y,
            scene.frame_width,
            scene.frame_height,
        );
        state.target_request_epoch = state.target_request_epoch.wrapping_add(1);
        let existing_scene = state
            .retained_image_scene
            .as_ref()
            .filter(|retained| retained.key() == &key)
            .cloned();
        (
            state.target_request_epoch,
            resource_id,
            source_path,
            existing_scene,
        )
    };
    let prepared_scene = match existing_scene {
        Some(retained) => retained,
        None => build_retained_image_scene(
            id,
            &source_path,
            &scene.document,
            &scene.document_key,
            scene.document_width,
            scene.document_height,
            scene.frame_x,
            scene.frame_y,
            scene.frame_width,
            scene.frame_height,
        )?,
    };
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    if state.target_request_epoch != request_epoch {
        return Err("viewport image scene superseded by a newer scene request".to_string());
    }
    let target = match state.target.as_mut() {
        Some(ViewportTarget::ImageComposite {
            resource_id: current_resource_id,
            document,
            document_key,
            document_width,
            document_height,
            frame_x,
            frame_y,
            frame_width,
            frame_height,
        }) if *current_resource_id == resource_id => (
            document,
            document_key,
            document_width,
            document_height,
            frame_x,
            frame_y,
            frame_width,
            frame_height,
        ),
        _ => return Err("viewport image composite target changed during scene build".to_string()),
    };
    *target.0 = scene.document;
    *target.1 = scene.document_key.clone();
    *target.2 = scene.document_width;
    *target.3 = scene.document_height;
    *target.4 = scene.frame_x;
    *target.5 = scene.frame_y;
    *target.6 = Some(scene.frame_width);
    *target.7 = Some(scene.frame_height);
    state.image_layer_presentation = state
        .image_layer_presentation
        .take()
        .filter(|current| current.base_document_key == scene.document_key);
    if state.image_layer_presentation.is_none() {
        state.retired_image_layer_transactions.clear();
    }
    state.retained_image_scene = Some(prepared_scene);
    state.bump_render_generation();
    Ok(())
}

/// Select a retained layer node and optionally apply one in-memory drag
/// transform. The transaction is scoped to the exact document key. A new
/// transaction is established only by sequence zero without a draft; every
/// subsequent packet must keep the transaction id and advance monotonically.
fn image_layer_transaction_ids(
    document: &Value,
    selected_layer_id: &str,
) -> Result<Vec<String>, String> {
    let layers = document
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| "image layer presentation requires a layered document".to_string())?;
    let selected = layers
        .iter()
        .find(|layer| layer.get("id").and_then(Value::as_str) == Some(selected_layer_id))
        .ok_or_else(|| format!("unknown selected layer id: {selected_layer_id}"))?;
    if selected.get("linked").and_then(Value::as_bool) != Some(true) {
        return Ok(vec![selected_layer_id.to_string()]);
    }
    let mut affected = layers
        .iter()
        .filter(|layer| {
            layer.get("linked").and_then(Value::as_bool) == Some(true)
                && layer.get("kind").and_then(Value::as_str) == Some("pixel")
                && layer.get("locked").and_then(Value::as_bool) != Some(true)
        })
        .filter_map(|layer| layer.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>();
    if !affected.iter().any(|id| id == selected_layer_id) {
        affected.push(selected_layer_id.to_string());
    }
    Ok(affected)
}

#[tauri::command]
pub(crate) fn viewport_present_image_layer_scene(
    viewport_id: String,
    mut presentation: ViewportImageLayerPresentation,
) -> Result<(), String> {
    presentation.validate()?;
    let id = parse_id(&viewport_id)?;
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    if state.kind != "image_edit" {
        return Err(format!(
            "viewport {viewport_id} (kind={}) does not accept image layer presentation",
            state.kind
        ));
    }
    let (document_key, document) = match state.target.as_ref() {
        Some(ViewportTarget::ImageComposite {
            document_key,
            document,
            ..
        }) => (document_key, document),
        _ => {
            return Err(format!(
                "viewport {viewport_id} has no image composite target"
            ));
        }
    };
    if presentation.base_document_key != *document_key {
        return Err(format!(
            "image layer presentation base document mismatch: expected {document_key}, got {}",
            presentation.base_document_key
        ));
    }
    if state
        .retained_image_scene
        .as_ref()
        .is_none_or(|scene| scene.document_key() != document_key)
    {
        return Err("image composite scene is not ready for the target document".to_string());
    }
    let active_transaction_id = state
        .image_layer_presentation
        .as_ref()
        .map(|current| current.transaction_id.as_str());
    if active_transaction_id != Some(presentation.transaction_id.as_str())
        && state
            .retired_image_layer_transactions
            .iter()
            .any(|transaction_id| transaction_id == &presentation.transaction_id)
    {
        return Err(format!(
            "image layer presentation transaction {} is retired",
            presentation.transaction_id
        ));
    }
    let mut retired_transaction = None;
    if let Some(current) = state.image_layer_presentation.as_ref() {
        if current.transaction_id != presentation.transaction_id {
            if !presentation.is_transaction_start() {
                return Err(format!(
                    "image layer presentation transaction mismatch: active {}, got {}",
                    current.transaction_id, presentation.transaction_id
                ));
            }
            retired_transaction = Some(current.transaction_id.clone());
            presentation.affected_layer_ids =
                image_layer_transaction_ids(document, &presentation.selected_layer_id)?;
        } else if current.selected_layer_id != presentation.selected_layer_id {
            return Err(format!(
                "image layer presentation transaction {} is fixed to selected layer {}, got {}",
                current.transaction_id, current.selected_layer_id, presentation.selected_layer_id
            ));
        } else if presentation.sequence <= current.sequence {
            return Err(format!(
                "image layer presentation sequence must advance past {}, got {}",
                current.sequence, presentation.sequence
            ));
        } else {
            presentation
                .affected_layer_ids
                .clone_from(&current.affected_layer_ids);
        }
    } else if !presentation.is_transaction_start() {
        return Err(
            "image layer presentation transaction must start at sequence 0 without moveDraft"
                .to_string(),
        );
    } else {
        presentation.affected_layer_ids =
            image_layer_transaction_ids(document, &presentation.selected_layer_id)?;
    }
    if let Some(retired) = retired_transaction {
        state
            .retired_image_layer_transactions
            .retain(|id| id != &retired);
        state.retired_image_layer_transactions.push(retired);
        if state.retired_image_layer_transactions.len() > 16 {
            state.retired_image_layer_transactions.remove(0);
        }
    }
    state.image_layer_presentation = Some(presentation);
    state.bump_render_generation();
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
    state.bump_content_generation();
    crate::commands::viewport_surface::invalidate_content(&viewport_id);
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
    state.bump_render_generation();
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
    state.bump_render_generation();
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
    state.bump_render_generation();
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
    let mut map = viewports()
        .lock()
        .map_err(|_| "viewport registry poisoned")?;
    let state = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
    state.view = ViewportView { zoom, pan_x, pan_y };
    state.bump_render_generation();
    // Render-only changes keep the previous complete texture usable as a fast
    // crop until the settled render arrives. Target/resize changes instead
    // invalidate `frame_tex` while holding this same registry lock, so this
    // path can never resurrect pixels from another backing surface.
    Ok(crate::commands::viewport_surface::present_view(
        &viewport_id,
        (zoom, pan_x, pan_y),
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex, MutexGuard};

    use super::*;

    static VIEWPORT_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct ViewportTestGuard {
        _serial: MutexGuard<'static, ()>,
    }

    impl Drop for ViewportTestGuard {
        fn drop(&mut self) {
            clear_test_viewports();
        }
    }

    fn clear_test_viewports() {
        let registry = viewports();
        let mut map = registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.clear();
        drop(map);
        registry.clear_poison();
    }

    fn viewport_test_guard() -> ViewportTestGuard {
        let serial = VIEWPORT_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        VIEWPORT_TEST_LOCK.clear_poison();
        clear_test_viewports();
        ViewportTestGuard { _serial: serial }
    }

    #[test]
    fn create_set_render_destroy_lifecycle() {
        let _guard = viewport_test_guard();
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
    fn image_composite_camera_and_resize_reuse_retained_layer_scene() {
        let _guard = viewport_test_guard();
        let path = std::env::temp_dir().join("hgripe_retained_scene_identity.png");
        image::RgbaImage::from_pixel(64, 48, image::Rgba([1, 2, 3, 255]))
            .save(&path)
            .expect("write source");
        let canonical = path.to_string_lossy().to_string();
        let resource_id = resource::id_for(&canonical);
        resource::put(
            &resource_id,
            resource::ResourceEntry {
                path: canonical.clone(),
                width: Some(64),
                height: Some(48),
            },
        );
        let desc = viewport_create("image_edit".to_string()).expect("create");
        let id = parse_id(&desc.viewport_id).expect("id");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::ImageComposite {
                resource_id,
                document: serde_json::json!({
                    "layers": [{
                        "id": "base",
                        "kind": "pixel",
                        "visible": true,
                        "opacity": 1.0,
                        "ops": [{
                            "type": "source_image",
                            "source": { "path": canonical, "width": 64, "height": 48 },
                            "placement": [0, 0, 64, 48]
                        }]
                    }]
                }),
                document_key: "document-a".to_string(),
                document_width: 64,
                document_height: 48,
                frame_x: 0.0,
                frame_y: 0.0,
                frame_width: Some(64),
                frame_height: Some(48),
            },
        )
        .expect("set target");
        let first = {
            let map = viewports().lock().expect("lock viewports");
            map.get(&id)
                .and_then(|state| state.retained_image_scene.clone())
                .expect("retained scene")
        };

        viewport_set_view(desc.viewport_id.clone(), 2.0, 0.25, 0.5).expect("set camera");
        viewport_resize(desc.viewport_id.clone(), 1280, 720).expect("resize");
        let after_camera = {
            let map = viewports().lock().expect("lock viewports");
            map.get(&id)
                .and_then(|state| state.retained_image_scene.clone())
                .expect("retained scene after view")
        };
        assert!(Arc::ptr_eq(&first, &after_camera));

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn image_scene_framebuffer_detail_prefers_native_frame_and_stays_bounded() {
        assert_eq!(
            image_scene_framebuffer_detail(4096, 3072, 1280, 720),
            4096,
            "a 4096-native frame must not be reduced to viewport detail"
        );
        assert_eq!(
            image_scene_framebuffer_detail(800, 800, 1280, 720),
            1280,
            "the viewport is the detail floor for a small frame"
        );
        assert_eq!(
            image_scene_framebuffer_detail(8192, 6144, 1280, 720),
            4096,
            "retained allocations remain bounded"
        );
        // Camera is deliberately absent from the detail function and cache
        // key. The preceding test changes camera state and asserts Arc reuse.
    }

    #[test]
    fn target_size_and_render_only_generations_have_distinct_lifetimes() {
        let _guard = viewport_test_guard();
        let desc = viewport_create("image_edit".to_string()).expect("create");
        let id = parse_id(&desc.viewport_id).expect("id");
        let initial = {
            let map = viewports().lock().expect("lock viewports");
            map.get(&id).expect("viewport").generations()
        };

        viewport_resize(desc.viewport_id.clone(), 640, 480).expect("resize");
        let after_content = {
            let map = viewports().lock().expect("lock viewports");
            map.get(&id).expect("viewport").generations()
        };
        assert_ne!(after_content.content, initial.content);
        assert_ne!(after_content.render, initial.render);
        assert!(!rendered_generations_match(after_content, initial));

        viewport_set_mask_overlay(desc.viewport_id.clone(), None).expect("clear mask overlay");
        let after_overlay = {
            let map = viewports().lock().expect("lock viewports");
            map.get(&id).expect("viewport").generations()
        };
        assert_eq!(after_overlay.content, after_content.content);
        assert_ne!(after_overlay.render, after_content.render);
        assert!(!rendered_generations_match(after_overlay, after_content));

        viewport_set_view(desc.viewport_id.clone(), 2.0, 0.25, 0.25).expect("set view");
        let after_view = {
            let map = viewports().lock().expect("lock viewports");
            map.get(&id).expect("viewport").generations()
        };
        assert_eq!(after_view.content, after_overlay.content);
        assert_ne!(after_view.render, after_overlay.render);
        assert!(!rendered_generations_match(after_view, after_overlay));

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
    }

    #[test]
    fn image_scene_commit_is_atomic_and_keeps_content_identity() {
        let _guard = viewport_test_guard();
        let path = std::env::temp_dir().join("hgripe_atomic_scene_commit.png");
        image::RgbaImage::from_pixel(16, 16, image::Rgba([4, 5, 6, 255]))
            .save(&path)
            .expect("write source");
        let canonical = path.to_string_lossy().to_string();
        let resource_id = resource::id_for(&canonical);
        resource::put(
            &resource_id,
            resource::ResourceEntry {
                path: canonical.clone(),
                width: Some(16),
                height: Some(16),
            },
        );
        let desc = viewport_create("image_edit".to_string()).expect("create");
        let id = parse_id(&desc.viewport_id).expect("id");
        let document = |dx: i32| {
            serde_json::json!({
                "layers": [{
                    "id": "base",
                    "kind": "pixel",
                    "visible": true,
                    "opacity": 1.0,
                    "ops": [
                        {
                            "type": "source_image",
                            "source": { "path": canonical, "width": 16, "height": 16 },
                            "placement": [0, 0, 16, 16]
                        },
                        { "type": "transform", "dx": dx, "dy": 0 }
                    ]
                }]
            })
        };
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::ImageComposite {
                resource_id,
                document: document(0),
                document_key: "document-a".to_string(),
                document_width: 16,
                document_height: 16,
                frame_x: 0.0,
                frame_y: 0.0,
                frame_width: Some(16),
                frame_height: Some(16),
            },
        )
        .expect("set target");
        let (before_scene, before_generations) = {
            let map = viewports().lock().expect("lock viewports");
            let state = map.get(&id).expect("viewport");
            (
                state.retained_image_scene.clone().expect("scene"),
                state.generations(),
            )
        };
        let invalid = ViewportImageScene {
            document: serde_json::json!({
                "layers": [{ "id": "base", "kind": "pixel", "visible": true, "ops": [] }]
            }),
            document_key: "invalid".to_string(),
            document_width: 16,
            document_height: 16,
            frame_x: 0.0,
            frame_y: 0.0,
            frame_width: 16,
            frame_height: 16,
        };
        assert!(viewport_set_image_scene_inner(desc.viewport_id.clone(), invalid).is_err());
        {
            let map = viewports().lock().expect("lock viewports");
            let state = map.get(&id).expect("viewport");
            assert!(Arc::ptr_eq(
                &before_scene,
                state.retained_image_scene.as_ref().expect("scene")
            ));
            assert_eq!(state.generations(), before_generations);
        }
        viewport_set_image_scene_inner(
            desc.viewport_id.clone(),
            ViewportImageScene {
                document: document(2),
                document_key: "document-b".to_string(),
                document_width: 16,
                document_height: 16,
                frame_x: 0.0,
                frame_y: 0.0,
                frame_width: 16,
                frame_height: 16,
            },
        )
        .expect("commit replacement scene");
        {
            let map = viewports().lock().expect("lock viewports");
            let state = map.get(&id).expect("viewport");
            assert_eq!(state.generations().content, before_generations.content);
            assert_ne!(state.generations().render, before_generations.render);
            assert!(!Arc::ptr_eq(
                &before_scene,
                state.retained_image_scene.as_ref().expect("scene")
            ));
            assert_eq!(
                state
                    .retained_image_scene
                    .as_ref()
                    .expect("scene")
                    .document_key(),
                "document-b"
            );
        }

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn layer_presentation_moves_linked_pixels_outside_document_and_frame_in_one_render() {
        let _guard = viewport_test_guard();
        let red_path = std::env::temp_dir().join("hgripe_scene_linked_red.png");
        let green_path = std::env::temp_dir().join("hgripe_scene_linked_green.png");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([220, 20, 40, 255]))
            .save(&red_path)
            .expect("write red source");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([20, 220, 40, 255]))
            .save(&green_path)
            .expect("write green source");
        let red = red_path.to_string_lossy().to_string();
        let green = green_path.to_string_lossy().to_string();
        let resource_id = resource::id_for(&red);
        resource::put(
            &resource_id,
            resource::ResourceEntry {
                path: red.clone(),
                width: Some(4),
                height: Some(4),
            },
        );
        let document = serde_json::json!({
            "layers": [
                {
                    "id": "selected",
                    "kind": "pixel",
                    "visible": true,
                    "linked": true,
                    "locked": false,
                    "opacity": 1.0,
                    "ops": [{
                        "type": "source_image",
                        "source": { "path": red, "width": 4, "height": 4 },
                        "placement": [0, 0, 4, 4]
                    }]
                },
                {
                    "id": "linked",
                    "kind": "pixel",
                    "visible": true,
                    "linked": true,
                    "locked": false,
                    "opacity": 1.0,
                    "ops": [{
                        "type": "source_image",
                        "source": { "path": green, "width": 4, "height": 4 },
                        "placement": [0, 4, 4, 8]
                    }]
                }
            ]
        });
        let desc = viewport_create("image_edit".to_string()).expect("create");
        viewport_resize(desc.viewport_id.clone(), 16, 8).expect("resize");
        viewport_set_target(
            desc.viewport_id.clone(),
            ViewportTarget::ImageComposite {
                resource_id,
                document,
                document_key: "linked-a".to_string(),
                document_width: 4,
                document_height: 4,
                frame_x: 0.0,
                frame_y: 0.0,
                frame_width: Some(16),
                frame_height: Some(8),
            },
        )
        .expect("set target");
        let presentation =
            |transaction_id: &str,
             base_document_key: &str,
             sequence: u64,
             move_draft: Option<crate::studio::SelectedLayerMoveDraft>| {
                ViewportImageLayerPresentation {
                    selected_layer_id: "selected".to_string(),
                    transaction_id: transaction_id.to_string(),
                    base_document_key: base_document_key.to_string(),
                    sequence,
                    move_draft,
                    affected_layer_ids: Vec::new(),
                }
            };
        viewport_present_image_layer_scene(
            desc.viewport_id.clone(),
            presentation("move-1", "linked-a", 0, None),
        )
        .expect("start transaction");
        viewport_present_image_layer_scene(
            desc.viewport_id.clone(),
            presentation(
                "move-1",
                "linked-a",
                1,
                Some(crate::studio::SelectedLayerMoveDraft { dx: 4.0, dy: 0.0 }),
            ),
        )
        .expect("present move");
        let rendered = viewport_render_rgba(&desc.viewport_id).expect("render preview");
        assert_eq!(rendered.image.get_pixel(4, 0).0, [220, 20, 40, 255]);
        assert_eq!(rendered.image.get_pixel(4, 4).0, [20, 220, 40, 255]);
        assert_eq!(rendered.image.get_pixel(0, 0).0, [0, 0, 0, 0]);
        assert_eq!(
            rendered.image_layer.document_key.as_deref(),
            Some("linked-a")
        );
        assert_eq!(
            rendered.image_layer.transaction_id.as_deref(),
            Some("move-1")
        );
        assert_eq!(rendered.image_layer.sequence, Some(1));
        let frame = rendered
            .image_layer
            .selected_layer_frame
            .expect("selected frame from the rendered pixels");
        assert_eq!(frame.rect, [4.0, 0.0, 8.0, 4.0]);

        assert!(viewport_present_image_layer_scene(
            desc.viewport_id.clone(),
            presentation(
                "move-2",
                "linked-a",
                1,
                Some(crate::studio::SelectedLayerMoveDraft { dx: 5.0, dy: 0.0 }),
            ),
        )
        .is_err());
        assert!(viewport_present_image_layer_scene(
            desc.viewport_id.clone(),
            presentation(
                "move-1",
                "linked-a",
                1,
                Some(crate::studio::SelectedLayerMoveDraft { dx: 5.0, dy: 0.0 }),
            ),
        )
        .is_err());
        assert!(viewport_present_image_layer_scene(
            desc.viewport_id.clone(),
            presentation("move-1", "wrong-base", 2, None),
        )
        .is_err());
        viewport_present_image_layer_scene(
            desc.viewport_id.clone(),
            presentation("move-2", "linked-a", 0, None),
        )
        .expect("replace transaction from a sequence-zero baseline");
        assert!(viewport_present_image_layer_scene(
            desc.viewport_id.clone(),
            presentation("move-1", "linked-a", 0, None),
        )
        .is_err());

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(red_path);
        let _ = std::fs::remove_file(green_path);
    }

    #[test]
    fn mask_overlay_only_on_image_edit_viewports_and_validates_the_buffer() {
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
    fn document_overlays_project_inside_a_larger_retained_scene_frame() {
        let mut mask_surface = hgripe_grade::GradeSurface {
            w: 4,
            h: 4,
            data: vec![0.0; 4 * 4 * 4],
            space: hgripe_grade::GradeSpace::Srgb,
        };
        let overlay = MaskOverlay {
            w: 2,
            h: 2,
            data: vec![255; 4],
            rgb: [255, 0, 0],
            alpha: 1.0,
            invert: false,
        };
        composite_document_mask_overlay(
            &mut mask_surface,
            &overlay,
            (2, 2),
            [-1.0, -1.0, 4.0, 4.0],
        );
        let pixel = |surface: &hgripe_grade::GradeSurface, x: usize, y: usize, channel: usize| {
            surface.data[(y * surface.w as usize + x) * 4 + channel]
        };
        assert!(pixel(&mask_surface, 1, 1, 0) > 0.9);
        assert!(pixel(&mask_surface, 2, 2, 0) > 0.9);
        assert_eq!(pixel(&mask_surface, 0, 0, 0), 0.0);
        assert_eq!(pixel(&mask_surface, 3, 3, 0), 0.0);

        let mut vector_surface = hgripe_grade::GradeSurface {
            w: 4,
            h: 4,
            data: vec![0.0; 4 * 4 * 4],
            space: hgripe_grade::GradeSpace::Srgb,
        };
        let scene = OverlayScene {
            items: vec![OverlayItem::Polygon {
                points: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
                stroke: [0.0, 0.0, 0.0, 0.0],
                fill: Some([0.0, 1.0, 0.0, 1.0]),
                dash: false,
            }],
            phase: 0.0,
        };
        composite_document_overlay_scene(
            &mut vector_surface,
            &scene,
            (2, 2),
            [-1.0, -1.0, 4.0, 4.0],
        );
        assert!(pixel(&vector_surface, 1, 1, 1) > 0.9);
        assert_eq!(pixel(&vector_surface, 0, 0, 1), 0.0);
        assert_eq!(pixel(&vector_surface, 3, 3, 1), 0.0);
    }

    #[test]
    fn frame_bin_payload_carries_meta_header_and_png_bytes() {
        let img = image::RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 255]));
        let png = encode_frame_png(&img).expect("encode png");

        let payload = frame_bin_payload(
            3,
            2,
            &cpu_backend(),
            false,
            &ViewportImageLayerFrameMetadata::default(),
            &png,
        )
        .expect("payload");
        let meta_len = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&payload[4..4 + meta_len]).expect("meta json");
        assert_eq!(meta["width"], 3);
        assert_eq!(meta["height"], 2);
        assert_eq!(meta["backend"]["actual"], "cpu");
        assert_eq!(meta["presented"], false);
        assert!(meta["selectedLayerFrame"].is_null());
        assert!(meta["documentKey"].is_null());
        assert!(meta["transactionId"].is_null());
        assert!(meta["sequence"].is_null());
        // The trailing bytes are the PNG, byte for byte.
        assert_eq!(&payload[4 + meta_len..], &png[..]);

        // A natively presented frame carries the flag and no PNG bytes.
        let payload = frame_bin_payload(
            3,
            2,
            &cpu_backend(),
            true,
            &ViewportImageLayerFrameMetadata::default(),
            &[],
        )
        .expect("payload");
        let meta_len = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&payload[4..4 + meta_len]).expect("meta json");
        assert_eq!(meta["presented"], true);
        assert!(payload[4 + meta_len..].is_empty());

        let image_layer = ViewportImageLayerFrameMetadata {
            selected_layer_frame: Some(crate::studio::SelectedLayerFrame {
                owner: "selected-layer-frame",
                shape: "axis-aligned-rect",
                layer_id: "layer-1".to_string(),
                rect: [4.0, 5.0, 14.0, 15.0],
                source_rect: [0.0, 0.0, 10.0, 10.0],
                source: "asset-frame",
            }),
            document_key: Some("document-a".to_string()),
            transaction_id: Some("transaction-a".to_string()),
            sequence: Some(7),
        };
        let payload = frame_bin_payload(3, 2, &cpu_backend(), false, &image_layer, &png)
            .expect("payload with image layer metadata");
        let meta_len = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&payload[4..4 + meta_len]).expect("meta json");
        assert_eq!(meta["selectedLayerFrame"]["layerId"], "layer-1");
        assert_eq!(
            meta["selectedLayerFrame"]["rect"],
            serde_json::json!([4.0, 5.0, 14.0, 15.0])
        );
        assert_eq!(meta["documentKey"], "document-a");
        assert_eq!(meta["transactionId"], "transaction-a");
        assert_eq!(meta["sequence"], 7);
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
                frame_x: 0.0,
                frame_y: 0.0,
                frame_width: None,
                frame_height: None,
                document: serde_json::json!({
                    "version": 3,
                    "layers": [
                        {
                            "id": "hidden",
                            "kind": "pixel",
                            "visible": false,
                            "opacity": 1.0,
                            "ops": [{ "type": "source_image", "placement": [0, 0, 64, 64] }]
                        },
                        {
                            "id": "copy",
                            "kind": "pixel",
                            "visible": true,
                            "opacity": 1.0,
                            "ops": [{ "type": "source_image", "placement": [0, 0, 64, 64] }],
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
        viewport_present_image_layer_scene(
            desc.viewport_id.clone(),
            ViewportImageLayerPresentation {
                selected_layer_id: "hidden".to_string(),
                transaction_id: "hidden-selection".to_string(),
                base_document_key: "copy-rect".to_string(),
                sequence: 0,
                move_draft: None,
                affected_layer_ids: Vec::new(),
            },
        )
        .expect("select hidden layer");
        let hidden = viewport_render_rgba(&desc.viewport_id).expect("render hidden selection");
        assert!(hidden.image_layer.selected_layer_frame.is_none());

        viewport_destroy_inner(desc.viewport_id).expect("destroy");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn image_composite_target_moves_linked_masks_with_transformed_layers() {
        let _guard = viewport_test_guard();
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
                frame_x: 0.0,
                frame_y: 0.0,
                frame_width: None,
                frame_height: None,
                document: serde_json::json!({
                    "version": 3,
                    "layers": [
                        { "kind": "mask", "visible": false, "opacity": 1.0, "ops": [] },
                        {
                            "id": "copy",
                            "kind": "pixel",
                            "visible": true,
                            "opacity": 1.0,
                            "ops": [
                                { "type": "source_image", "placement": [0, 0, 64, 64] },
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
        let _guard = viewport_test_guard();
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
