//! Native surface presentation windows for viewports
//! (WGPU_SURFACE_SWAP_PLAN Phase S1, feature `viewport-surface`, Windows).
//!
//! Each presented viewport owns one child window parented under the main app
//! window, kept at the bottom of the sibling z-order so the (transparent)
//! webview composites all DOM UI above it. The child never takes input
//! (`WS_DISABLED` + `WS_EX_TRANSPARENT`); it exists only between the first
//! `viewport_set_placement` and the viewport's destroy. On placement the
//! surface is cleared through the shared wgpu device — the S1 proof that the
//! swapchain presents under the webview; S2 replaces the clear with the real
//! image blit. Every GPU failure downgrades: the child window stays (or is
//! hidden) and the PNG transport keeps presenting, per the fallback contract.

use crate::commands::viewport::ensure_viewport;

/// Physical placement of a child window inside the parent's client area:
/// logical CSS pixels scaled by `dpr`, rounded to device pixels, with the
/// size floored at 1 so a degenerate rect cannot create an invalid surface.
pub(crate) fn physical_rect(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    dpr: f64,
) -> (i32, i32, i32, i32) {
    let dpr = if dpr.is_finite() && dpr > 0.0 {
        dpr
    } else {
        1.0
    };
    let px = (x * dpr).round() as i32;
    let py = (y * dpr).round() as i32;
    let pw = ((width * dpr).round() as i32).max(1);
    let ph = ((height * dpr).round() as i32).max(1);
    (px, py, pw, ph)
}

fn validate_placement(x: f64, y: f64, width: f64, height: f64, dpr: f64) -> Result<(), String> {
    let values = [x, y, width, height, dpr];
    if values.iter().any(|v| !v.is_finite()) {
        return Err("placement values must be finite".to_string());
    }
    if width < 0.0 || height < 0.0 {
        return Err(format!(
            "placement size must not be negative: {width}x{height}"
        ));
    }
    Ok(())
}

/// Guard a frame upload against the device's 2D texture size limit: an
/// oversized frame must downgrade to the PNG transport with a visible reason
/// (WGPU plan fallback hardening) instead of tripping a wgpu validation
/// error on `create_texture`.
#[cfg_attr(not(all(windows, feature = "viewport-surface")), allow(dead_code))]
fn frame_within_texture_limit(width: u32, height: u32, max: u32) -> Result<(), String> {
    if width > max || height > max {
        return Err(format!(
            "frame {width}x{height} exceeds the device texture limit ({max}px per side)"
        ));
    }
    Ok(())
}

/// A normalized view window over the document: `(zoom, pan_x, pan_y)` where
/// the window spans `[pan, pan + 1/zoom]` on each axis (the viewport view
/// contract). The surface caches the window its frame texture covers so a
/// later view can re-present as a pure GPU crop of the same texture.
type ViewWindow = (f32, f32, f32);

/// The blit uniform: NDC quad scale/offset plus the UV rect sampled from the
/// frame texture — `[sx, sy, ox, oy, u0, v0, uw, vh]`.
type BlitUniform = [f32; 8];

/// Identity presentation of a `fit`-scaled quad sampling the whole texture.
#[cfg_attr(not(all(windows, feature = "viewport-surface")), allow(dead_code))]
fn identity_uniform(fit: [f32; 2]) -> BlitUniform {
    [fit[0], fit[1], 0.0, 0.0, 0.0, 0.0, 1.0, 1.0]
}

/// The uniform presenting the `req` view window out of a texture covering the
/// `cov` window, aspect-fit scaled by `fit`. The quad shrinks to the covered
/// intersection (background shows where the texture has no pixels — a
/// zoom-out past the cached crop letterboxes until the settle render lands);
/// `None` when the windows do not overlap at all (present the bare clear).
#[cfg_attr(not(all(windows, feature = "viewport-surface")), allow(dead_code))]
fn crop_uniform(cov: ViewWindow, req: ViewWindow, fit: [f32; 2]) -> Option<BlitUniform> {
    let (zc, pcx, pcy) = cov;
    let (zr, prx, pry) = req;
    if !(zc > 0.0 && zr > 0.0) {
        return None;
    }
    let axis = |pc: f32, pr: f32| -> Option<(f32, f32, f32, f32)> {
        let lo = pr.max(pc);
        let hi = (pr + 1.0 / zr).min(pc + 1.0 / zc);
        if hi <= lo {
            return None;
        }
        // Fractions of the requested window the intersection spans, and the
        // UV range of the covering texture it samples.
        Some((
            (lo - pr) * zr,
            (hi - pr) * zr,
            (lo - pc) * zc,
            (hi - pc) * zc,
        ))
    };
    let (fx0, fx1, u0, u1) = axis(pcx, prx)?;
    let (fy0, fy1, v0, v1) = axis(pcy, pry)?;
    Some([
        (fx1 - fx0) * fit[0],
        (fy1 - fy0) * fit[1],
        (fx0 + fx1 - 1.0) * fit[0],
        (1.0 - (fy0 + fy1)) * fit[1],
        u0,
        v0,
        u1 - u0,
        v1 - v0,
    ])
}

/// Report the frontend receives from `viewport_set_placement`: whether the
/// native surface path took the placement, in the shared fallback vocabulary.
/// `presented: false` + a reason means the PNG transport stays authoritative.
#[derive(Clone, serde::Serialize)]
pub(crate) struct PlacementReport {
    pub presented: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

impl PlacementReport {
    fn fallback(reason: impl Into<String>) -> Self {
        PlacementReport {
            presented: false,
            fallback_reason: Some(reason.into()),
        }
    }
}

/// Report (or move) the native surface window under the viewport's element
/// rect. `x`/`y`/`width`/`height` are logical CSS pixels relative to the
/// webview's client origin; `dpr` converts to device pixels. The child window
/// is created lazily on the first placement and the surface is cleared as the
/// S1 presentation proof. Never fails on missing GPU/platform support —
/// that's a reported fallback, not an error.
#[tauri::command]
pub(crate) fn viewport_set_placement(
    window: tauri::WebviewWindow,
    viewport_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    dpr: f64,
) -> Result<PlacementReport, String> {
    ensure_viewport(&viewport_id)?;
    validate_placement(x, y, width, height, dpr)?;
    #[cfg(all(windows, feature = "viewport-surface"))]
    {
        return Ok(native::set_placement(
            &window,
            &viewport_id,
            physical_rect(x, y, width, height, dpr),
        ));
    }
    #[cfg(not(all(windows, feature = "viewport-surface")))]
    {
        let _ = window;
        Ok(PlacementReport::fallback(if cfg!(windows) {
            "viewport-surface feature disabled"
        } else {
            "native surface presentation is Windows-only"
        }))
    }
}

/// Show/hide the viewport's surface window without destroying it (occlusion:
/// modals over the hole, hidden panels). A no-op when no window exists yet.
#[tauri::command]
pub(crate) fn viewport_set_presented(
    window: tauri::WebviewWindow,
    viewport_id: String,
    presented: bool,
) -> Result<(), String> {
    ensure_viewport(&viewport_id)?;
    #[cfg(all(windows, feature = "viewport-surface"))]
    {
        native::set_presented(&window, &viewport_id, presented);
    }
    #[cfg(not(all(windows, feature = "viewport-surface")))]
    {
        let _ = (window, presented);
    }
    Ok(())
}

/// Destroy the viewport's surface window, if one exists. Called from
/// `viewport_destroy`; safe for viewports that never presented.
#[cfg(all(windows, feature = "viewport-surface"))]
pub(crate) fn destroy_surface(app: &tauri::AppHandle, viewport_id: &str) {
    native::destroy(app, viewport_id);
}

#[cfg(not(all(windows, feature = "viewport-surface")))]
pub(crate) fn destroy_surface(_app: &tauri::AppHandle, _viewport_id: &str) {}

/// Present a rendered frame on the viewport's native surface window (surface
/// swap Phase S2): upload the pixels as a texture and blit aspect-fit over
/// the app background. Returns `true` when the frame is on the surface — the
/// caller then skips the PNG transport entirely. Any failure (no window, no
/// GPU, device loss) returns `false` per the fallback contract: the PNG
/// transport stays authoritative, never an error.
#[cfg(all(windows, feature = "viewport-surface"))]
pub(crate) fn present_frame(
    _app: &tauri::AppHandle,
    viewport_id: &str,
    image: &image::RgbaImage,
    view: ViewWindow,
) -> bool {
    native::present_frame(viewport_id, image, view)
}

#[cfg(not(all(windows, feature = "viewport-surface")))]
pub(crate) fn present_frame(
    _app: &tauri::AppHandle,
    _viewport_id: &str,
    _image: &image::RgbaImage,
    _view: ViewWindow,
) -> bool {
    false
}

/// Present a decoded D3D11 hardware frame on the viewport's native surface
/// through the WGPU import (video zero-copy phase 3): no CPU readback, no
/// upload, no PNG. `Err` carries the reason the caller reports before
/// running the CPU render fallback.
#[cfg(all(windows, feature = "viewport-surface", feature = "native-ffmpeg"))]
pub(crate) fn present_hw_frame(
    viewport_id: &str,
    frame: &crate::studio::ffmpeg_native::D3d11Frame,
    view: ViewWindow,
) -> Result<(), String> {
    native::present_hw_frame(viewport_id, frame, view)
}

/// Re-present the surface's cached frame texture cropped to `view` — a pure
/// GPU pass with no render, no upload, and no pixel IPC (the zoom/pan fast
/// path). Returns `false` when there is no presented texture to crop (never
/// presented, hidden, no GPU): the caller simply waits for the settle render.
#[cfg(all(windows, feature = "viewport-surface"))]
pub(crate) fn present_view(viewport_id: &str, view: ViewWindow) -> bool {
    native::present_view(viewport_id, view)
}

#[cfg(not(all(windows, feature = "viewport-surface")))]
pub(crate) fn present_view(_viewport_id: &str, _view: ViewWindow) -> bool {
    false
}

/// Read the viewport surface's last presented frame texture back to CPU
/// bytes (surface swap Phase S4: export preview, scopes, colour picking).
/// `None` means no presented texture exists — the caller answers from the
/// CPU reference render instead, per the fallback contract.
#[cfg(all(windows, feature = "viewport-surface"))]
pub(crate) fn read_surface_pixels(viewport_id: &str) -> Option<(u32, u32, Vec<u8>)> {
    native::read_pixels(viewport_id)
}

#[cfg(not(all(windows, feature = "viewport-surface")))]
pub(crate) fn read_surface_pixels(_viewport_id: &str) -> Option<(u32, u32, Vec<u8>)> {
    None
}

#[cfg(all(windows, feature = "viewport-surface"))]
mod native {
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;

    use tauri::Manager;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, MoveWindow, RegisterClassW, SetWindowPos,
        ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNA,
        WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_DISABLED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
    };

    use super::{
        crop_uniform, frame_within_texture_limit, identity_uniform, PlacementReport, ViewWindow,
    };
    use crate::studio::wgpu_device::{
        record_surface_profile_failure, record_surface_profile_success, shared_gpu_cached,
        shared_gpu_for_surface, surface_instance, SharedGpu,
    };

    /// One viewport's presentation window and its (re)configurable surface.
    /// `HWND` is stored as `isize` so the entry is `Send`; every Win32 call
    /// happens on the main thread via `run_on_main_thread`.
    struct Entry {
        hwnd: isize,
        surface: Option<wgpu::Surface<'static>>,
        config: Option<wgpu::SurfaceConfiguration>,
        presented: bool,
        /// Cached frame texture + bind group, recreated when the frame size
        /// changes; a same-size frame only re-uploads pixels.
        frame_tex: Option<FrameTexture>,
        /// Blit uniform buffer (quad NDC rect + sampled UV rect), written per
        /// present.
        fit_buf: Option<wgpu::Buffer>,
        /// The normalized view window the cached frame texture covers.
        frame_view: ViewWindow,
        /// A view window re-presented as a GPU crop of the cached texture
        /// (the zoom/pan fast path); `None` presents the texture whole.
        crop_view: Option<ViewWindow>,
    }

    struct FrameTexture {
        texture: wgpu::Texture,
        bind_group: wgpu::BindGroup,
        width: u32,
        height: u32,
        /// The texture's pixel format: `Rgba8Unorm` for CPU-uploaded frames,
        /// `Bgra8Unorm` for imported D3D11 hardware frames. Sampling is
        /// format-agnostic; only the raw readback needs to know.
        format: wgpu::TextureFormat,
    }

    static SURFACES: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();

    fn surfaces() -> &'static Mutex<HashMap<String, Entry>> {
        SURFACES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Process-wide native-surface capability fallback. If the shared WGPU
    /// adapter cannot configure a Win32 child-window surface, retrying every
    /// layout tick only floods the terminal; the PNG/WebView transport is the
    /// authoritative fallback until the next app launch.
    static SURFACE_DISABLED_REASON: OnceLock<Mutex<Option<String>>> = OnceLock::new();

    fn surface_disabled_reason() -> Option<String> {
        SURFACE_DISABLED_REASON
            .get_or_init(|| Mutex::new(None))
            .lock()
            .ok()
            .and_then(|reason| reason.clone())
    }

    fn is_permanent_surface_fallback(reason: &str) -> bool {
        let reason = reason.to_ascii_lowercase();
        reason.contains("shared adapter")
            || reason.contains("not supported")
            || reason.contains("without a presentation surface")
            || reason.contains("surface creation failed")
            || reason.contains("surface window class registration failed")
    }

    fn disable_surface(reason: impl Into<String>) -> String {
        let reason = reason.into();
        if let Ok(mut disabled) = SURFACE_DISABLED_REASON
            .get_or_init(|| Mutex::new(None))
            .lock()
        {
            if disabled.is_none() {
                *disabled = Some(reason.clone());
            }
        }
        record_surface_profile_failure(reason.clone());
        reason
    }

    /// The registered window class atom for surface children, one per process.
    static WINDOW_CLASS: OnceLock<u16> = OnceLock::new();

    /// UTF-16 window class name, NUL-terminated.
    const CLASS_NAME: [u16; 24] = {
        let mut buf = [0u16; 24];
        let name = b"hgripe-viewport-surface";
        let mut i = 0;
        while i < name.len() {
            buf[i] = name[i] as u16;
            i += 1;
        }
        buf
    };

    fn window_class() -> u16 {
        *WINDOW_CLASS.get_or_init(|| unsafe {
            let class = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(DefWindowProcW),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: GetModuleHandleW(std::ptr::null()),
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                // No background brush: wgpu owns every presented pixel and a
                // GDI erase would flash before the first clear.
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: CLASS_NAME.as_ptr(),
            };
            RegisterClassW(&class)
        })
    }

    /// Run `f` on the main thread and wait for its result. Win32 windows are
    /// owned by the thread that created them, so creation, movement, and
    /// destruction all dispatch here.
    fn on_main_thread<T: Send + 'static>(
        app: &tauri::AppHandle,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| format!("main thread dispatch failed: {e}"))?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|e| format!("main thread dispatch timed out: {e}"))
    }

    /// Create the child window under `parent`, hidden, input-transparent, at
    /// the bottom of the sibling z-order. Main thread only.
    unsafe fn create_child(parent: HWND, rect: (i32, i32, i32, i32)) -> Result<isize, String> {
        if window_class() == 0 {
            return Err("surface window class registration failed".to_string());
        }
        let hwnd = CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
            CLASS_NAME.as_ptr(),
            std::ptr::null(),
            WS_CHILD | WS_DISABLED | WS_CLIPSIBLINGS,
            rect.0,
            rect.1,
            rect.2,
            rect.3,
            parent,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return Err("surface child window creation failed".to_string());
        }
        SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        Ok(hwnd as isize)
    }

    fn surface_target(hwnd: isize) -> Result<wgpu::SurfaceTargetUnsafe, String> {
        Ok(wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(wgpu::rwh::RawDisplayHandle::Windows(
                wgpu::rwh::WindowsDisplayHandle::new(),
            )),
            raw_window_handle: wgpu::rwh::RawWindowHandle::Win32(
                wgpu::rwh::Win32WindowHandle::new(
                    std::num::NonZeroIsize::new(hwnd).ok_or("surface window handle is null")?,
                ),
            ),
        })
    }

    fn create_surface(
        instance: &wgpu::Instance,
        hwnd: isize,
    ) -> Result<wgpu::Surface<'static>, String> {
        // Safety: the Entry owns the Win32 child window and drops the surface
        // before destroying that window.
        unsafe { instance.create_surface_unsafe(surface_target(hwnd)?) }
            .map_err(|e| format!("surface creation failed: {e}"))
    }

    fn ensure_surface_gpu(entry: &mut Entry) -> Result<Arc<SharedGpu>, String> {
        if let Some(cached) = shared_gpu_cached() {
            let gpu = cached?;
            if !gpu.surface_compatible {
                return Err(
                    "shared WGPU device was initialised without a presentation surface; restart required for zero-copy surface profile"
                        .to_string(),
                );
            }
            if entry.surface.is_none() {
                entry.surface = Some(create_surface(&gpu.instance, entry.hwnd)?);
                entry.config = None;
            }
            return Ok(gpu);
        }

        let instance = surface_instance();
        let surface = create_surface(&instance, entry.hwnd)?;
        let gpu = shared_gpu_for_surface(instance, &surface)?;
        entry.surface = Some(surface);
        entry.config = None;
        Ok(gpu)
    }

    /// WGSL blit: a quad scaled to the aspect-fit rect, sampling the frame
    /// texture; everything outside the quad keeps the clear (app background).
    const BLIT_SHADER: &str = r#"
struct Fit { scale: vec2<f32>, offset: vec2<f32>, uv_off: vec2<f32>, uv_scale: vec2<f32> };
@group(0) @binding(0) var frame_tex: texture_2d<f32>;
@group(0) @binding(1) var frame_samp: sampler;
@group(0) @binding(2) var<uniform> fit: Fit;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
    let c = corners[i];
    var out: VsOut;
    out.pos = vec4<f32>(c * fit.scale + fit.offset, 0.0, 1.0);
    out.uv = fit.uv_off + vec2<f32>(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5) * fit.uv_scale;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    return textureSample(frame_tex, frame_samp, in.uv);
}
"#;

    /// Compiled blit pipeline for one swapchain format, shared by every
    /// surface entry (formats in practice collapse to one per adapter).
    struct BlitPipeline {
        pipeline: wgpu::RenderPipeline,
        layout: wgpu::BindGroupLayout,
        sampler: wgpu::Sampler,
    }

    static BLIT_PIPELINES: OnceLock<Mutex<HashMap<wgpu::TextureFormat, Arc<BlitPipeline>>>> =
        OnceLock::new();

    fn blit_pipeline(
        gpu: &SharedGpu,
        format: wgpu::TextureFormat,
    ) -> Result<Arc<BlitPipeline>, String> {
        let mut map = BLIT_PIPELINES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "blit pipeline cache poisoned")?;
        if let Some(blit) = map.get(&format) {
            return Ok(blit.clone());
        }
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("viewport-surface-blit"),
            source: wgpu::ShaderSource::Wgsl(BLIT_SHADER.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("viewport-surface-blit"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("viewport-surface-blit"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("viewport-surface-blit"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                // Straight-alpha blending: RGBA frames (cutouts, transparent
                // sources) composite over the cleared app background, matching
                // the PNG transport's `<img>` over the stage colour.
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("viewport-surface-blit"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let blit = Arc::new(BlitPipeline {
            pipeline,
            layout,
            sampler,
        });
        map.insert(format, blit.clone());
        Ok(blit)
    }

    /// Upload the frame's pixels to the entry's cached texture, recreated
    /// only when the frame size changes — a slider drag re-uploads pixels
    /// into the same texture.
    fn upload_frame(
        gpu: &SharedGpu,
        entry: &mut Entry,
        image: &image::RgbaImage,
        format: wgpu::TextureFormat,
    ) -> Result<(), String> {
        let (iw, ih) = image.dimensions();
        if iw == 0 || ih == 0 {
            return Err("empty frame".to_string());
        }
        frame_within_texture_limit(iw, ih, gpu.device.limits().max_texture_dimension_2d)?;
        if entry.fit_buf.is_none() {
            entry.fit_buf = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("viewport-surface-fit"),
                size: 32,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
        }
        let needs_texture = entry
            .frame_tex
            .as_ref()
            .is_none_or(|t| t.width != iw || t.height != ih);
        if needs_texture {
            let blit = blit_pipeline(gpu, format)?;
            let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("viewport-surface-frame"),
                size: wgpu::Extent3d {
                    width: iw,
                    height: ih,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                // Non-sRGB: the frame carries display-ready sRGB bytes and the
                // swapchain is non-sRGB too, so sampling passes them verbatim.
                format: wgpu::TextureFormat::Rgba8Unorm,
                // COPY_SRC: `viewport_read_pixels` reads the presented frame
                // back for export preview / scopes / colour picking (S4).
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("viewport-surface-frame"),
                layout: &blit.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&blit.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: entry
                            .fit_buf
                            .as_ref()
                            .expect("fit buffer just ensured")
                            .as_entire_binding(),
                    },
                ],
            });
            entry.frame_tex = Some(FrameTexture {
                texture,
                bind_group,
                width: iw,
                height: ih,
                format: wgpu::TextureFormat::Rgba8Unorm,
            });
        }
        let tex = entry.frame_tex.as_ref().expect("texture just ensured");
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &tex.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            image.as_raw(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * iw),
                rows_per_image: Some(ih),
            },
            wgpu::Extent3d {
                width: iw,
                height: ih,
                depth_or_array_layers: 1,
            },
        );
        Ok(())
    }

    /// The aspect-fit quad scale in NDC for a `fw`x`fh` frame on a `sw`x`sh`
    /// surface: letterbox/pillarbox, never crop, never stretch.
    fn fit_scale(fw: u32, fh: u32, sw: u32, sh: u32) -> [f32; 2] {
        let (fw, fh) = (fw.max(1) as f32, fh.max(1) as f32);
        let (sw, sh) = (sw.max(1) as f32, sh.max(1) as f32);
        let scale = (sw / fw).min(sh / fh);
        [(fw * scale / sw).min(1.0), (fh * scale / sh).min(1.0)]
    }

    #[cfg(test)]
    mod tests {
        use super::fit_scale;
        use crate::commands::viewport_surface::{crop_uniform, identity_uniform};

        #[test]
        fn crop_uniform_identity_when_windows_match() {
            let fit = [1.0, 0.5];
            let u = crop_uniform((2.0, 0.25, 0.25), (2.0, 0.25, 0.25), fit).unwrap();
            let id = identity_uniform(fit);
            for (a, b) in u.iter().zip(id.iter()) {
                assert!((a - b).abs() < 1e-5, "{u:?} vs {id:?}");
            }
        }

        #[test]
        fn crop_uniform_zoom_in_samples_a_sub_window() {
            // Texture covers the whole frame; the view asks for the centre
            // quarter: full quad, UV rect [0.25, 0.75].
            let u = crop_uniform((1.0, 0.0, 0.0), (2.0, 0.25, 0.25), [1.0, 1.0]).unwrap();
            let expect = [1.0, 1.0, 0.0, 0.0, 0.25, 0.25, 0.5, 0.5];
            for (a, b) in u.iter().zip(expect.iter()) {
                assert!((a - b).abs() < 1e-5, "{u:?}");
            }
        }

        #[test]
        fn crop_uniform_zoom_out_shrinks_the_quad() {
            // Texture covers the centre quarter; the view asks for the whole
            // frame: the quad shrinks to the covered half extent, whole UV.
            let u = crop_uniform((2.0, 0.25, 0.25), (1.0, 0.0, 0.0), [1.0, 1.0]).unwrap();
            let expect = [0.5, 0.5, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0];
            for (a, b) in u.iter().zip(expect.iter()) {
                assert!((a - b).abs() < 1e-5, "{u:?}");
            }
        }

        #[test]
        fn crop_uniform_rejects_disjoint_and_degenerate_windows() {
            assert!(crop_uniform((4.0, 0.0, 0.0), (4.0, 0.5, 0.5), [1.0, 1.0]).is_none());
            assert!(crop_uniform((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), [1.0, 1.0]).is_none());
        }

        #[test]
        fn fit_scale_letterboxes_without_crop_or_stretch() {
            let close = |a: f32, b: f32| (a - b).abs() < 1e-5;
            // Same aspect: fills the surface.
            let [sx, sy] = fit_scale(1920, 1080, 960, 540);
            assert!(close(sx, 1.0) && close(sy, 1.0), "{sx} {sy}");
            // Wider frame on a squarer surface: full width, letterboxed height.
            let [sx, sy] = fit_scale(1920, 1080, 1000, 1000);
            assert!(close(sx, 1.0), "{sx}");
            assert!(close(sy, 1080.0 / 1920.0), "{sy}");
            // Taller frame: full height, pillarboxed width.
            let [sx, sy] = fit_scale(1080, 1920, 1000, 1000);
            assert!(close(sy, 1.0), "{sy}");
            assert!(close(sx, 1080.0 / 1920.0), "{sx}");
            // Degenerate inputs never divide by zero or exceed the surface.
            let [sx, sy] = fit_scale(0, 0, 0, 0);
            assert!(sx <= 1.0 && sy <= 1.0);
        }
    }

    /// Create (or reuse) the entry's wgpu surface, reconfigure it to `w`x`h`
    /// if the size changed, and present one frame: a clear to the app
    /// background, plus the aspect-fit blit of the last uploaded frame
    /// texture when one exists (S2) - a bare clear until then (S1).
    fn clear_surface(gpu: &SharedGpu, entry: &mut Entry, w: u32, h: u32) -> Result<(), String> {
        let surface = entry
            .surface
            .as_ref()
            .ok_or("surface was not created before presentation")?;
        let needs_config = entry
            .config
            .as_ref()
            .is_none_or(|c| c.width != w || c.height != h);
        if needs_config {
            let mut config = surface
                .get_default_config(&gpu.adapter, w, h)
                .ok_or("surface is not supported by the shared adapter")?;
            config.present_mode = wgpu::PresentMode::AutoNoVsync;
            // Frames carry display-ready sRGB bytes; a non-sRGB swapchain
            // presents them verbatim (identical to the PNG transport) instead
            // of applying a second transfer curve.
            config.format = config.format.remove_srgb_suffix();
            surface.configure(&gpu.device, &config);
            let info = gpu.adapter.get_info();
            record_surface_profile_success(
                info.name.clone(),
                format!("{:?}", info.backend),
                format!("{:?}", config.format),
            );
            entry.config = Some(config);
        }
        let frame = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            status => return Err(format!("surface frame acquire failed: {status:?}")),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        // Draw the last uploaded frame texture over the clear when one
        // exists; the uniform is refreshed here so a placement resize
        // re-letterboxes the same texture without a re-upload, and an active
        // view crop (the zoom/pan fast path) presents its window of it.
        let blit = match &entry.frame_tex {
            Some(tex) => {
                let format = entry.config.as_ref().expect("config just ensured").format;
                let fit = fit_scale(tex.width, tex.height, w, h);
                let uniform = match entry.crop_view {
                    Some(req) => crop_uniform(entry.frame_view, req, fit),
                    None => Some(identity_uniform(fit)),
                };
                match uniform {
                    Some(uniform) => {
                        let mut bytes = [0u8; 32];
                        for (i, v) in uniform.iter().enumerate() {
                            bytes[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
                        }
                        gpu.queue.write_buffer(
                            entry.fit_buf.as_ref().expect("fit buffer set with texture"),
                            0,
                            &bytes,
                        );
                        Some((blit_pipeline(gpu, format)?, &tex.bind_group))
                    }
                    // The view window is entirely outside the cached frame:
                    // present the bare background until the settle render.
                    None => None,
                }
            }
            None => None,
        };
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("viewport-surface-present"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("viewport-surface-present"),
                multiview_mask: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // The app's canvas background colour (--bg), so the
                        // letterbox reads as chrome, not as a glitch.
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.008,
                            g: 0.009,
                            b: 0.016,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            if let Some((blit, bind_group)) = &blit {
                pass.set_pipeline(&blit.pipeline);
                pass.set_bind_group(0, *bind_group, &[]);
                pass.draw(0..6, 0..1);
            }
        }
        gpu.queue.submit([encoder.finish()]);
        frame.present();
        Ok(())
    }

    /// S2 frame presentation: upload the rendered pixels and blit them on the
    /// viewport's surface. `false` means the caller must fall back to the PNG
    /// transport (no surface window, hidden, no GPU, or a device error).
    pub(super) fn present_frame(
        viewport_id: &str,
        image: &image::RgbaImage,
        view: ViewWindow,
    ) -> bool {
        if surface_disabled_reason().is_some() {
            return false;
        }
        let gpu = match shared_gpu_cached() {
            Some(Ok(gpu)) if gpu.surface_compatible => gpu,
            _ => return false,
        };
        let mut map = match surfaces().lock() {
            Ok(map) => map,
            Err(_) => return false,
        };
        let Some(entry) = map.get_mut(viewport_id) else {
            return false;
        };
        if !entry.presented || entry.config.is_none() {
            return false;
        }
        let result = (|| -> Result<(), String> {
            let format = entry.config.as_ref().expect("config checked").format;
            upload_frame(&gpu, entry, image, format)?;
            // The fresh frame covers `view` whole: it supersedes any crop.
            entry.frame_view = view;
            entry.crop_view = None;
            let (w, h) = {
                let config = entry.config.as_ref().expect("config checked");
                (config.width, config.height)
            };
            clear_surface(&gpu, entry, w, h)
        })();
        match result {
            Ok(()) => true,
            Err(reason) => {
                if is_permanent_surface_fallback(&reason) {
                    let reason = disable_surface(reason);
                    eprintln!("[viewport] native surface disabled for this session: {reason}");
                    return false;
                }
                eprintln!("[viewport] surface present fell back for {viewport_id}: {reason}");
                false
            }
        }
    }

    /// The video zero-copy presentation path (GPU_DEVICE_STRATEGY_PLAN phase
    /// 3): import a decoded D3D11 hardware frame into the shared WGPU device
    /// and present it on the viewport's surface — the pixels never visit the
    /// CPU. The imported texture replaces the entry's cached frame texture,
    /// so the zoom/pan crop fast path and the S4 readback work on it like on
    /// an uploaded frame. Errors carry the reason the caller reports before
    /// running the CPU fallback.
    #[cfg(feature = "native-ffmpeg")]
    pub(super) fn present_hw_frame(
        viewport_id: &str,
        frame: &crate::studio::ffmpeg_native::D3d11Frame,
        view: ViewWindow,
    ) -> Result<(), String> {
        if let Some(reason) = surface_disabled_reason() {
            return Err(format!("native surface disabled: {reason}"));
        }
        let gpu = match shared_gpu_cached() {
            Some(Ok(gpu)) if gpu.surface_compatible => gpu,
            Some(Ok(_)) => {
                return Err(
                    "shared WGPU device was initialised without a presentation surface".to_string(),
                )
            }
            Some(Err(e)) => return Err(format!("shared WGPU device unavailable: {e}")),
            None => return Err("shared WGPU device not initialised yet".to_string()),
        };
        let mut map = surfaces()
            .lock()
            .map_err(|_| "surface registry poisoned".to_string())?;
        let entry = map
            .get_mut(viewport_id)
            .ok_or_else(|| format!("no surface window for viewport {viewport_id}"))?;
        if !entry.presented || entry.config.is_none() {
            return Err("viewport surface is not presented".to_string());
        }
        let format = entry.config.as_ref().expect("config checked").format;
        let texture = crate::studio::d3d11_wgpu::import_d3d11_frame(&gpu.device, frame)?;
        if entry.fit_buf.is_none() {
            entry.fit_buf = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("viewport-surface-fit"),
                size: 32,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
        }
        let blit = blit_pipeline(&gpu, format)?;
        let tex_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("viewport-surface-hw-frame"),
            layout: &blit.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&tex_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&blit.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: entry
                        .fit_buf
                        .as_ref()
                        .expect("fit buffer just ensured")
                        .as_entire_binding(),
                },
            ],
        });
        entry.frame_tex = Some(FrameTexture {
            width: texture.width(),
            height: texture.height(),
            texture,
            bind_group,
            format: wgpu::TextureFormat::Bgra8Unorm,
        });
        // The imported texture always covers the whole frame (identity
        // window); a zoom/pan view presents as a GPU crop of it — the same
        // mechanism as the zoom/pan fast path, so later views keep cropping
        // the same texture.
        entry.frame_view = (1.0, 0.0, 0.0);
        entry.crop_view = if view == (1.0, 0.0, 0.0) {
            None
        } else {
            Some(view)
        };
        let (w, h) = {
            let config = entry.config.as_ref().expect("config checked");
            (config.width, config.height)
        };
        clear_surface(&gpu, entry, w, h)
    }

    /// The zoom/pan fast path: re-present the cached frame texture cropped to
    /// `view` — one uniform write and one render pass, no render, no upload.
    pub(super) fn present_view(viewport_id: &str, view: ViewWindow) -> bool {
        if surface_disabled_reason().is_some() {
            return false;
        }
        let gpu = match shared_gpu_cached() {
            Some(Ok(gpu)) if gpu.surface_compatible => gpu,
            _ => return false,
        };
        let mut map = match surfaces().lock() {
            Ok(map) => map,
            Err(_) => return false,
        };
        let Some(entry) = map.get_mut(viewport_id) else {
            return false;
        };
        if !entry.presented || entry.config.is_none() || entry.frame_tex.is_none() {
            return false;
        }
        entry.crop_view = Some(view);
        let (w, h) = {
            let config = entry.config.as_ref().expect("config checked");
            (config.width, config.height)
        };
        match clear_surface(&gpu, entry, w, h) {
            Ok(()) => true,
            Err(reason) => {
                if is_permanent_surface_fallback(&reason) {
                    let reason = disable_surface(reason);
                    eprintln!("[viewport] native surface disabled for this session: {reason}");
                    return false;
                }
                eprintln!("[viewport] surface view present fell back for {viewport_id}: {reason}");
                false
            }
        }
    }

    /// S4 readback: copy the entry's presented frame texture into a mapped
    /// buffer and return the unpadded RGBA rows. `None` when the viewport has
    /// no presented texture (never presented, hidden, no GPU) — the CPU
    /// reference path answers instead.
    pub(super) fn read_pixels(viewport_id: &str) -> Option<(u32, u32, Vec<u8>)> {
        let gpu = match shared_gpu_cached()? {
            Ok(gpu) if gpu.surface_compatible => gpu,
            _ => return None,
        };
        let map = surfaces().lock().ok()?;
        let entry = map.get(viewport_id)?;
        if !entry.presented {
            return None;
        }
        let tex = entry.frame_tex.as_ref()?;
        let (w, h) = (tex.width, tex.height);
        // wgpu requires bytes_per_row aligned to COPY_BYTES_PER_ROW_ALIGNMENT.
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize;
        let unpadded = w as usize * 4;
        let padded = unpadded.div_ceil(align) * align;
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("viewport-surface-readback"),
            size: (padded * h as usize) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("viewport-surface-readback"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &tex.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded as u32),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        gpu.queue.submit([encoder.finish()]);
        let slice = buffer.slice(..);
        let (tx, rx) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        if gpu
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .is_err()
        {
            return None;
        }
        rx.recv_timeout(Duration::from_secs(10)).ok()?.ok()?;
        let data = slice.get_mapped_range();
        let mut pixels = Vec::with_capacity(unpadded * h as usize);
        for row in 0..h as usize {
            let start = row * padded;
            pixels.extend_from_slice(&data[start..start + unpadded]);
        }
        drop(data);
        buffer.unmap();
        if tex.format == wgpu::TextureFormat::Bgra8Unorm {
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
        }
        Some((w, h, pixels))
    }

    pub(super) fn set_placement(
        window: &tauri::WebviewWindow,
        viewport_id: &str,
        rect: (i32, i32, i32, i32),
    ) -> PlacementReport {
        if let Some(reason) = surface_disabled_reason() {
            return PlacementReport::fallback(reason);
        }
        let parent = match window.hwnd() {
            Ok(hwnd) => hwnd.0 as isize,
            Err(e) => return PlacementReport::fallback(format!("no parent window handle: {e}")),
        };
        let id = viewport_id.to_string();
        let placed = on_main_thread(window.app_handle(), move || -> Result<(), String> {
            let mut map = surfaces().lock().map_err(|_| "surface registry poisoned")?;
            let entry = match map.get_mut(&id) {
                Some(entry) => entry,
                None => {
                    let hwnd = unsafe { create_child(parent as HWND, rect) }?;
                    eprintln!("[viewport] surface window created for {id}");
                    map.entry(id.clone()).or_insert(Entry {
                        hwnd,
                        surface: None,
                        config: None,
                        presented: false,
                        frame_tex: None,
                        fit_buf: None,
                        frame_view: (1.0, 0.0, 0.0),
                        crop_view: None,
                    })
                }
            };
            unsafe {
                MoveWindow(entry.hwnd as HWND, rect.0, rect.1, rect.2, rect.3, 1);
            }
            let gpu = ensure_surface_gpu(entry)?;
            clear_surface(&gpu, entry, rect.2.max(1) as u32, rect.3.max(1) as u32)?;
            if !entry.presented {
                unsafe {
                    ShowWindow(entry.hwnd as HWND, SW_SHOWNA);
                    SetWindowPos(
                        entry.hwnd as HWND,
                        HWND_BOTTOM,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
                entry.presented = true;
            }
            Ok(())
        });
        match placed {
            Ok(Ok(())) => PlacementReport {
                presented: true,
                fallback_reason: None,
            },
            Ok(Err(reason)) | Err(reason) => {
                if is_permanent_surface_fallback(&reason) {
                    let reason = disable_surface(reason);
                    eprintln!("[viewport] native surface disabled for this session: {reason}");
                    return PlacementReport::fallback(reason);
                }
                eprintln!("[viewport] surface placement fell back for {viewport_id}: {reason}");
                PlacementReport::fallback(reason)
            }
        }
    }

    pub(super) fn set_presented(window: &tauri::WebviewWindow, viewport_id: &str, presented: bool) {
        let id = viewport_id.to_string();
        let result = on_main_thread(window.app_handle(), move || {
            let Ok(mut map) = surfaces().lock() else {
                return;
            };
            if let Some(entry) = map.get_mut(&id) {
                unsafe {
                    ShowWindow(
                        entry.hwnd as HWND,
                        if presented { SW_SHOWNA } else { SW_HIDE },
                    );
                }
                entry.presented = presented;
            }
        });
        if let Err(reason) = result {
            eprintln!("[viewport] set_presented({presented}) failed for {viewport_id}: {reason}");
        }
    }

    pub(super) fn destroy(app: &tauri::AppHandle, viewport_id: &str) {
        let id = viewport_id.to_string();
        let result = on_main_thread(app, move || {
            let Ok(mut map) = surfaces().lock() else {
                return;
            };
            if let Some(entry) = map.remove(&id) {
                // Drop the surface before its window goes away.
                drop(entry.surface);
                unsafe {
                    DestroyWindow(entry.hwnd as HWND);
                }
                eprintln!("[viewport] surface window destroyed for {id}");
            }
        });
        if let Err(reason) = result {
            eprintln!("[viewport] surface destroy failed for {viewport_id}: {reason}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_rect_scales_and_rounds_by_dpr() {
        assert_eq!(
            physical_rect(10.0, 20.0, 100.0, 50.0, 1.0),
            (10, 20, 100, 50)
        );
        assert_eq!(
            physical_rect(10.4, 20.5, 100.25, 50.75, 2.0),
            (21, 41, 201, 102)
        );
        assert_eq!(physical_rect(0.0, 0.0, 99.6, 66.4, 1.25), (0, 0, 125, 83));
    }

    #[test]
    fn physical_rect_floors_size_at_one_and_survives_bad_dpr() {
        assert_eq!(physical_rect(5.0, 5.0, 0.0, 0.0, 2.0), (10, 10, 1, 1));
        // Non-finite / non-positive dpr falls back to 1.0 instead of
        // producing a degenerate window.
        assert_eq!(
            physical_rect(3.0, 4.0, 10.0, 10.0, f64::NAN),
            (3, 4, 10, 10)
        );
        assert_eq!(physical_rect(3.0, 4.0, 10.0, 10.0, 0.0), (3, 4, 10, 10));
        assert_eq!(physical_rect(3.0, 4.0, 10.0, 10.0, -2.0), (3, 4, 10, 10));
    }

    #[test]
    fn oversized_frames_downgrade_with_a_visible_reason() {
        assert!(frame_within_texture_limit(8192, 8192, 8192).is_ok());
        let err = frame_within_texture_limit(8193, 4096, 8192).unwrap_err();
        assert!(err.contains("8193x4096"), "{err}");
        assert!(err.contains("8192"), "{err}");
        assert!(frame_within_texture_limit(4096, 8193, 8192).is_err());
    }

    #[test]
    fn placement_validation_rejects_non_finite_and_negative_sizes() {
        assert!(validate_placement(0.0, 0.0, 10.0, 10.0, 1.0).is_ok());
        assert!(validate_placement(f64::INFINITY, 0.0, 10.0, 10.0, 1.0).is_err());
        assert!(validate_placement(0.0, f64::NAN, 10.0, 10.0, 1.0).is_err());
        assert!(validate_placement(0.0, 0.0, -1.0, 10.0, 1.0).is_err());
        assert!(validate_placement(0.0, 0.0, 10.0, -1.0, 1.0).is_err());
    }
}
