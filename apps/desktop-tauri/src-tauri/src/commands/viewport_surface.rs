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

#[cfg(all(windows, feature = "viewport-surface"))]
mod native {
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use tauri::Manager;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, MoveWindow, RegisterClassW, SetWindowPos,
        ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNA,
        WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_DISABLED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
    };

    use super::PlacementReport;
    use crate::studio::wgpu_device::{shared_gpu, SharedGpu};

    /// One viewport's presentation window and its (re)configurable surface.
    /// `HWND` is stored as `isize` so the entry is `Send`; every Win32 call
    /// happens on the main thread via `run_on_main_thread`.
    struct Entry {
        hwnd: isize,
        surface: Option<wgpu::Surface<'static>>,
        config: Option<wgpu::SurfaceConfiguration>,
        presented: bool,
    }

    static SURFACES: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();

    fn surfaces() -> &'static Mutex<HashMap<String, Entry>> {
        SURFACES.get_or_init(|| Mutex::new(HashMap::new()))
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

    /// Create (or reuse) the entry's wgpu surface, reconfigure it to `w`x`h`
    /// if the size changed, and present one clear frame — the S1 placement
    /// proof that the swapchain draws under the webview.
    fn clear_surface(gpu: &SharedGpu, entry: &mut Entry, w: u32, h: u32) -> Result<(), String> {
        if entry.surface.is_none() {
            let target = wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: Some(wgpu::rwh::RawDisplayHandle::Windows(
                    wgpu::rwh::WindowsDisplayHandle::new(),
                )),
                raw_window_handle: wgpu::rwh::RawWindowHandle::Win32(
                    wgpu::rwh::Win32WindowHandle::new(
                        std::num::NonZeroIsize::new(entry.hwnd)
                            .ok_or("surface window handle is null")?,
                    ),
                ),
            };
            // Safety: the child window outlives the surface — the entry owns
            // both and destroys the surface before the window.
            let surface = unsafe { gpu.instance.create_surface_unsafe(target) }
                .map_err(|e| format!("surface creation failed: {e}"))?;
            entry.surface = Some(surface);
            entry.config = None;
        }
        let surface = entry.surface.as_ref().expect("surface just ensured");
        let needs_config = entry
            .config
            .as_ref()
            .is_none_or(|c| c.width != w || c.height != h);
        if needs_config {
            let mut config = surface
                .get_default_config(&gpu.adapter, w, h)
                .ok_or("surface is not supported by the shared adapter")?;
            config.present_mode = wgpu::PresentMode::AutoNoVsync;
            surface.configure(&gpu.device, &config);
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
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("viewport-surface-clear"),
            });
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("viewport-surface-clear"),
            multiview_mask: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    // The app's canvas background colour (--bg), so the S1
                    // clear reads as chrome, not as a glitch.
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
        gpu.queue.submit([encoder.finish()]);
        frame.present();
        Ok(())
    }

    pub(super) fn set_placement(
        window: &tauri::WebviewWindow,
        viewport_id: &str,
        rect: (i32, i32, i32, i32),
    ) -> PlacementReport {
        let gpu = match shared_gpu() {
            Ok(gpu) => gpu,
            Err(reason) => return PlacementReport::fallback(reason),
        };
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
                    })
                }
            };
            unsafe {
                MoveWindow(entry.hwnd as HWND, rect.0, rect.1, rect.2, rect.3, 1);
            }
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
    fn placement_validation_rejects_non_finite_and_negative_sizes() {
        assert!(validate_placement(0.0, 0.0, 10.0, 10.0, 1.0).is_ok());
        assert!(validate_placement(f64::INFINITY, 0.0, 10.0, 10.0, 1.0).is_err());
        assert!(validate_placement(0.0, f64::NAN, 10.0, 10.0, 1.0).is_err());
        assert!(validate_placement(0.0, 0.0, -1.0, 10.0, 1.0).is_err());
        assert!(validate_placement(0.0, 0.0, 10.0, -1.0, 1.0).is_err());
    }
}
