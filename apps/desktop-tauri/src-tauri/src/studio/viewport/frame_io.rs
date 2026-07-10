use std::fs::{self, File};
use std::path::Path;
use std::sync::Arc;

use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};

use super::{
    ensure_viewport, surface_backend_report, viewport_render_rgba,
    viewport_render_rgba_with_overlay, ViewportBackend, ViewportFrame, ViewportView,
};

#[tauri::command]
pub(crate) fn viewport_render_frame(viewport_id: String) -> Result<ViewportFrame, String> {
    rgba_to_frame(viewport_render_rgba(&viewport_id)?)
}

/// A rendered frame before transport encoding: 8-bit sRGB pixels plus the
/// backend report. The PNG encode happens at the transport boundary so the
/// native surface path can present the same pixels without an encode.
pub(super) struct RenderedRgba {
    pub(super) image: Arc<RgbaImage>,
    pub(super) backend: ViewportBackend,
    /// The view window the frame was rendered for — the native surface
    /// caches it so later views re-present as GPU crops (the fast path).
    pub(super) view: ViewportView,
}

pub(super) fn encode_frame_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
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
    if let Some((w, h)) = super::try_present_hw_video_frame(&viewport_id) {
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

pub(super) fn pixels_bin_payload(
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

pub(super) fn frame_bin_payload(
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
