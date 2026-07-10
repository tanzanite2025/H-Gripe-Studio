use std::sync::Arc;

use image::RgbaImage;

use super::viewports;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct ProxyKey {
    pub(super) path: String,
    pub(super) time_bits: Option<u64>,
    pub(super) size: u32,
}

pub(super) struct SourceProxy {
    pub(super) key: ProxyKey,
    pub(super) srgb: Arc<RgbaImage>,
    pub(super) source_dims: Option<(u32, u32)>,
}

pub(super) const PROXY_CACHE_DEPTH: usize = 8;

#[derive(Clone, Copy)]
pub(super) struct ViewportView {
    pub(super) zoom: f32,
    pub(super) pan_x: f32,
    pub(super) pan_y: f32,
}

impl ViewportView {
    pub(super) const IDENTITY: ViewportView = ViewportView {
        zoom: 1.0,
        pan_x: 0.0,
        pan_y: 0.0,
    };

    pub(super) fn is_identity(self) -> bool {
        self.zoom <= 1.0 && self.pan_x == 0.0 && self.pan_y == 0.0
    }
}

pub(super) fn crop_view(srgb: &RgbaImage, view: ViewportView) -> RgbaImage {
    let (w, h) = srgb.dimensions();
    let zoom = view.zoom.max(1.0);
    let vw = ((w as f32 / zoom).round() as u32).clamp(1, w);
    let vh = ((h as f32 / zoom).round() as u32).clamp(1, h);
    let x = ((view.pan_x * w as f32).round() as i64).clamp(0, (w - vw) as i64) as u32;
    let y = ((view.pan_y * h as f32).round() as i64).clamp(0, (h - vh) as i64) as u32;
    image::imageops::crop_imm(srgb, x, y, vw, vh).to_image()
}

pub(super) fn proxy_detail_size(size: u32, view: ViewportView) -> u32 {
    const MAX_PROXY_DIM: u32 = 4096;
    let zoom = view.zoom.clamp(1.0, 8.0);
    let mut detail = size;
    while (detail as f32) < (size as f32) * zoom && detail < MAX_PROXY_DIM {
        detail = (detail * 2).min(MAX_PROXY_DIM);
    }
    detail
}

pub(super) fn cached_proxy(
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
                source_dims: None,
            },
        );
        state.proxies.truncate(PROXY_CACHE_DEPTH);
    }
    Ok(srgb)
}

pub(super) fn cached_proxy_with_dims(
    id: u64,
    key: ProxyKey,
    decode: impl FnOnce() -> Result<(RgbaImage, (u32, u32)), String>,
) -> Result<(Arc<RgbaImage>, (u32, u32)), String> {
    {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        if let Some(state) = map.get_mut(&id) {
            if let Some(pos) = state.proxies.iter().position(|proxy| proxy.key == key) {
                if let Some(dims) = state.proxies[pos].source_dims {
                    let hit = state.proxies.remove(pos);
                    let srgb = hit.srgb.clone();
                    state.proxies.insert(0, hit);
                    return Ok((srgb, dims));
                }
            }
        }
    }
    let (srgb, dims) = decode()?;
    let srgb = Arc::new(srgb);
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
                source_dims: Some(dims),
            },
        );
        state.proxies.truncate(PROXY_CACHE_DEPTH);
    }
    Ok((srgb, dims))
}
