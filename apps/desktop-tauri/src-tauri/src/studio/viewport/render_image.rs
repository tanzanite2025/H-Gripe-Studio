use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;

use crate::studio::{
    load_image_srgb_proxy, load_image_srgb_proxy_with_dims, parse_grade_doc, ResolvedClipProps,
};

use super::*;

pub(super) fn render_image_composite_path(
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
    let mut load_source = |source_path: &str| {
        let key = ProxyKey {
            path: source_path.to_string(),
            time_bits: None,
            size: detail,
        };
        cached_proxy(id, key, || {
            load_image_srgb_proxy(std::path::Path::new(source_path), detail)
        })
        .map(|proxy| (*proxy).clone())
    };
    let mut image = crate::studio::image_document::composite_image_document_with_sources(
        &proxy,
        document,
        document_width.max(1),
        document_height.max(1),
        detail,
        &mut load_source,
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
