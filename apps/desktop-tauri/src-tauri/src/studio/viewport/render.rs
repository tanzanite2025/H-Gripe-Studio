use std::sync::Arc;

use image::RgbaImage;

use crate::resource;
use crate::studio::{apply_clip_props_srgb_proxy_preferred, ClipPropsBackend, ResolvedClipProps};

use super::*;

pub(super) fn grade_backend_report(backend: crate::studio::GradeBackend) -> ViewportBackend {
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

/// Render the viewport's frame to 8-bit sRGB pixels (no transport encode) —
/// the shared ingress of both egress paths: PNG transport and native surface
/// presentation.
pub(super) fn viewport_render_rgba(viewport_id: &str) -> Result<RenderedRgba, String> {
    viewport_render_rgba_with_overlay(viewport_id, true)
}

pub(super) fn viewport_render_rgba_with_overlay(
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
        retained_image_scene,
        image_layer_presentation,
        generations,
    ) = {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        let state = map
            .get_mut(&id)
            .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
        (
            state.target.as_ref().map(ViewportTarget::render_snapshot),
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
            state.retained_image_scene.clone(),
            state.image_layer_presentation.clone(),
            state.generations(),
        )
    };
    let target = target.ok_or_else(|| format!("viewport {viewport_id} has no target"))?;
    let mut rendered = match target {
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
            document: _,
            document_key,
            document_width,
            document_height,
            frame_x,
            frame_y,
            frame_width,
            frame_height,
        } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            let scene = retained_image_scene
                .ok_or_else(|| format!("viewport {viewport_id} has no retained image scene"))?;
            render_image_composite_path(
                scene,
                &entry.path,
                &document_key,
                document_width,
                document_height,
                frame_x,
                frame_y,
                frame_width.unwrap_or(document_width),
                frame_height.unwrap_or(document_height),
                width,
                height,
                grade_doc,
                view,
                mask_overlay.as_deref(),
                overlay_scene.as_deref(),
                image_layer_presentation.as_ref(),
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
                render_image_path(
                    id,
                    &clip.path,
                    width,
                    height,
                    grade_doc,
                    view,
                    None,
                    overlay_scene.as_deref(),
                    clip_props.as_ref(),
                )
            } else {
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
    }?;
    rendered.generations = generations;
    Ok(rendered)
}

/// Run the clip property raster over a decoded proxy. `source_dims` are the
/// source's full-resolution dimensions: position/anchor are authored in
/// source pixels, so they scale by the proxy ratio before the pass — the
/// preview then composes identically to the full-resolution export.
pub(super) fn apply_clip_props_to_proxy(
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
