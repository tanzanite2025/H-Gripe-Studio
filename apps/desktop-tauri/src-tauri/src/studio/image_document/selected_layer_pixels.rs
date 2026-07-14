use std::path::Path;

use serde_json::Value;

use super::selection_assist_layer_pixels_in_frame;
use crate::studio::studio_image::{load_rgba, DEFAULT_MAX_DECODE_PIXELS};
use crate::studio::viewport::{cpu_backend, pixels_bin_payload};

async fn read_selected_layer_pixels_response(
    image_path: String,
    document: Value,
    selected_layer_id: String,
    document_width: u32,
    document_height: u32,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = image_path.trim();
        if trimmed.is_empty() {
            return Err("selection assist read requires an image path".to_string());
        }
        let source = load_rgba(Path::new(trimmed), DEFAULT_MAX_DECODE_PIXELS)?.image;
        let mut load_source = |source_path: &str| {
            load_rgba(Path::new(source_path), DEFAULT_MAX_DECODE_PIXELS).map(|loaded| loaded.image)
        };
        let image = selection_assist_layer_pixels_in_frame(
            &source,
            &document,
            &selected_layer_id,
            document_width.max(1),
            document_height.max(1),
            frame_x,
            frame_y,
            frame_width.max(1),
            frame_height.max(1),
            frame_width.max(frame_height).max(1),
            &mut load_source,
        )?;
        let (w, h) = image.dimensions();
        Ok(tauri::ipc::Response::new(pixels_bin_payload(
            w,
            h,
            &cpu_backend(),
            image.as_raw(),
        )?))
    })
    .await
    .map_err(|err| format!("selected layer pixels read task failed: {err}"))?
}

#[tauri::command]
pub(crate) async fn read_selection_assist_pixels(
    image_path: String,
    document: Value,
    selected_layer_id: String,
    document_width: u32,
    document_height: u32,
    frame_x: f32,
    frame_y: f32,
    frame_width: u32,
    frame_height: u32,
) -> Result<tauri::ipc::Response, String> {
    read_selected_layer_pixels_response(
        image_path,
        document,
        selected_layer_id,
        document_width,
        document_height,
        frame_x,
        frame_y,
        frame_width,
        frame_height,
    )
    .await
}
