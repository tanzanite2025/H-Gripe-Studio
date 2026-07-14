use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;

use crate::studio::{
    load_image_srgb_proxy, load_image_srgb_proxy_with_dims, parse_grade_doc,
    render_retained_image_scene, ResolvedClipProps, RetainedImageScene, RetainedImageSceneKey,
};

use super::*;

const MAX_IMAGE_SCENE_FRAMEBUFFER_DETAIL: u32 = 4096;

/// Allocate retained compositor pixels from frame identity, never camera
/// state. Native frame detail is preferred so a zoom crop samples authored
/// pixels instead of a viewport-sized downsample; the viewport size is only a
/// floor for small/proxy frames, and the allocation remains bounded.
pub(super) fn image_scene_framebuffer_detail(
    frame_width: u32,
    frame_height: u32,
    viewport_width: u32,
    viewport_height: u32,
) -> u32 {
    frame_width
        .max(frame_height)
        .max(viewport_width.max(viewport_height).clamp(64, 2048))
        .clamp(64, MAX_IMAGE_SCENE_FRAMEBUFFER_DETAIL)
}

pub(super) fn render_image_composite_path(
    retained_scene: Arc<RetainedImageScene>,
    path: &str,
    document_key: &str,
    document_width: u32,
    document_height: u32,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
    width: u32,
    height: u32,
    grade_doc: Option<Value>,
    view: ViewportView,
    mask_overlay: Option<&MaskOverlay>,
    overlay_scene: Option<&OverlayScene>,
    presentation: Option<&ViewportImageLayerPresentation>,
) -> Result<RenderedRgba, String> {
    let document_width = document_width.max(1);
    let document_height = document_height.max(1);
    let frame_width = frame_width.max(1);
    let frame_height = frame_height.max(1);
    let expected_key = RetainedImageSceneKey::new(
        path,
        document_key,
        document_width,
        document_height,
        frame_x,
        frame_y,
        frame_width,
        frame_height,
    );
    if retained_scene.key() != &expected_key {
        return Err("retained image scene does not match the current target revision".to_string());
    }
    let active_presentation = presentation.filter(|value| value.base_document_key == document_key);
    let rendered_scene = render_retained_image_scene(
        &retained_scene,
        frame_x,
        frame_y,
        frame_width,
        frame_height,
        image_scene_framebuffer_detail(frame_width, frame_height, width, height),
        view.zoom,
        view.pan_x,
        view.pan_y,
        active_presentation.map(|value| value.selected_layer_id.as_str()),
        active_presentation.map(|value| value.affected_layer_ids.as_slice()),
        active_presentation.and_then(|value| value.move_draft),
    )?;
    let visible_frame = rendered_scene.visible_frame;
    let image_layer = ViewportImageLayerFrameMetadata {
        selected_layer_frame: rendered_scene.selected_layer_frame,
        document_key: Some(document_key.to_string()),
        transaction_id: active_presentation.map(|value| value.transaction_id.clone()),
        sequence: active_presentation.map(|value| value.sequence),
    };
    let image = rendered_scene.image;
    if grade_doc.is_some() || mask_overlay.is_some() || overlay_scene.is_some() {
        let doc = parse_grade_doc(grade_doc.as_ref())?;
        let mut surface = crate::studio::srgb_proxy_surface(&image)?;
        let backend = crate::studio::apply_grade_doc(&doc, &mut surface);
        if let Some(overlay) = mask_overlay {
            composite_document_mask_overlay(
                &mut surface,
                overlay,
                (document_width, document_height),
                visible_frame,
            );
        }
        if let Some(scene) = overlay_scene {
            composite_document_overlay_scene(
                &mut surface,
                scene,
                (document_width, document_height),
                visible_frame,
            );
        }
        let image = crate::studio::surface_to_rgba(&surface)?;
        return Ok(RenderedRgba {
            image: Arc::new(image),
            backend: grade_backend_report(backend),
            view,
            generations: ViewportGenerations::default(),
            image_layer,
        });
    }
    Ok(RenderedRgba {
        image: Arc::new(image),
        backend: cpu_backend(),
        view,
        generations: ViewportGenerations::default(),
        image_layer,
    })
}

/// Render one still-image source (an image resource or a layer artifact) at
/// the viewport's size, applying its grade doc, view and mask overlay. The
/// decoded sRGB proxy is cached on the viewport keyed by path + size, so a
/// slider drag or a pan/zoom tick re-runs only crop + kernel.
pub(super) fn render_image_path(
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
            generations: ViewportGenerations::default(),
            image_layer: ViewportImageLayerFrameMetadata::default(),
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
        generations: ViewportGenerations::default(),
        image_layer: ViewportImageLayerFrameMetadata::default(),
    })
}
