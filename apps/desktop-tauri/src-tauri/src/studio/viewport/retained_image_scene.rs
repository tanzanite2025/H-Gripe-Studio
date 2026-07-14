use std::sync::Arc;

use serde_json::Value;

use crate::studio::{
    load_image_srgb_proxy, retain_image_document_scene, RetainedImageScene, RetainedImageSceneKey,
};

use super::{cached_proxy, ProxyKey};

const MAX_RETAINED_PIXEL_STORE_DETAIL: u32 = 4096;

fn source_detail(document_width: u32, document_height: u32) -> u32 {
    document_width
        .max(document_height)
        .clamp(1, MAX_RETAINED_PIXEL_STORE_DETAIL)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_retained_image_scene(
    viewport_id: u64,
    source_path: &str,
    document: &Value,
    document_key: &str,
    document_width: u32,
    document_height: u32,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
) -> Result<Arc<RetainedImageScene>, String> {
    let key = RetainedImageSceneKey::new(
        source_path,
        document_key,
        document_width,
        document_height,
        frame_x,
        frame_y,
        frame_width,
        frame_height,
    );
    let detail = source_detail(document_width, document_height);
    let shared = cached_proxy(
        viewport_id,
        ProxyKey {
            path: source_path.to_string(),
            time_bits: None,
            size: detail,
        },
        || load_image_srgb_proxy(std::path::Path::new(source_path), detail),
    )?;
    let mut load_source = |path: &str, requested_detail: u32| {
        let requested_detail = requested_detail.clamp(1, MAX_RETAINED_PIXEL_STORE_DETAIL);
        cached_proxy(
            viewport_id,
            ProxyKey {
                path: path.to_string(),
                time_bits: None,
                size: requested_detail,
            },
            || load_image_srgb_proxy(std::path::Path::new(path), requested_detail),
        )
    };
    retain_image_document_scene(
        key,
        document,
        document_width,
        document_height,
        shared,
        &mut load_source,
    )
    .map(Arc::new)
}
