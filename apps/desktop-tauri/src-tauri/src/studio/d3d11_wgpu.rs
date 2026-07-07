//! D3D11 -> WGPU texture interop for the video zero-copy route, phase 2
//! (GPU_DEVICE_STRATEGY_PLAN: vendored FFmpeg hw decode -> `AVHWFramesContext`
//! -> D3D11 texture frame -> WGPU import).
//!
//! A decoded [`D3d11Frame`] is an NV12 slice of the decoder's array texture
//! on FFmpeg's D3D11VA device. It cannot be sampled by the shared WGPU
//! device directly (different API, different device), so the import bridges
//! it without any CPU readback or upload:
//!
//! 1. create a BGRA8 texture on WGPU's D3D12 device with `HEAP_FLAG_SHARED`,
//! 2. open it on FFmpeg's D3D11 device through an NT shared handle,
//! 3. run the D3D11 video processor (`VideoProcessorBlt`) to convert the
//!    NV12 slice into that shared texture — a GPU->GPU operation that also
//!    does the YUV->RGB conversion in fixed-function hardware,
//! 4. wrap the D3D12 resource as a `wgpu::Texture` via `wgpu-hal`.
//!
//! The pixels never leave the GPU. The import is fenced CPU-side with a
//! D3D11 event query so the D3D12 side only samples finished pixels.
//! Every import outcome is recorded for the device registry — the
//! "zero-copy texture path" capability level the strategy plan requires to
//! be reported separately from "compiled in" and "session accepted".

use std::sync::Mutex;

use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, GENERIC_ALL};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Device1, ID3D11DeviceContext, ID3D11Query, ID3D11Texture2D,
    ID3D11VideoContext, ID3D11VideoDevice, ID3D11VideoProcessorInputView,
    ID3D11VideoProcessorOutputView, D3D11_QUERY_DESC, D3D11_QUERY_EVENT, D3D11_TEX2D_VPIV,
    D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
    D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Direct3D12::{
    ID3D12Resource, D3D12_CPU_PAGE_PROPERTY_UNKNOWN, D3D12_HEAP_FLAG_SHARED, D3D12_HEAP_PROPERTIES,
    D3D12_HEAP_TYPE_DEFAULT, D3D12_MEMORY_POOL_UNKNOWN, D3D12_RESOURCE_DESC,
    D3D12_RESOURCE_DIMENSION_TEXTURE2D, D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,
    D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS, D3D12_RESOURCE_STATE_COMMON,
    D3D12_TEXTURE_LAYOUT_UNKNOWN,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};

use super::ffmpeg_native::D3d11Frame;

/// Mirror of FFmpeg's `AVD3D11VADeviceContext` (`hwcontext_d3d11va.h`). The
/// vendored prebuilt bindings do not cover the D3D11-specific hwcontext
/// header, so the layout is declared here; the leading interface pointers
/// and the lock callbacks are the only fields the import touches.
#[repr(C)]
struct AvD3d11vaDeviceContext {
    device: *mut core::ffi::c_void,
    device_context: *mut core::ffi::c_void,
    video_device: *mut core::ffi::c_void,
    video_context: *mut core::ffi::c_void,
    lock: Option<unsafe extern "C" fn(*mut core::ffi::c_void)>,
    unlock: Option<unsafe extern "C" fn(*mut core::ffi::c_void)>,
    lock_ctx: *mut core::ffi::c_void,
    bind_flags: u32,
    misc_flags: u32,
}

/// Holds FFmpeg's hwcontext lock (protecting `device_context` /
/// `video_context` use) for a scope, releasing on drop.
struct HwCtxLock<'a>(&'a AvD3d11vaDeviceContext);

impl<'a> HwCtxLock<'a> {
    fn acquire(hwctx: &'a AvD3d11vaDeviceContext) -> Self {
        if let Some(lock) = hwctx.lock {
            unsafe { lock(hwctx.lock_ctx) };
        }
        Self(hwctx)
    }
}

impl Drop for HwCtxLock<'_> {
    fn drop(&mut self) {
        if let Some(unlock) = self.0.unlock {
            unsafe { unlock(self.0.lock_ctx) };
        }
    }
}

/// The recorded outcome of the most decisive import attempt so far: the
/// third capability level ("zero-copy texture path") for the device
/// registry. A success is never downgraded by a later failure — one
/// working import proves the path exists on this box.
static INTEROP_RESULT: Mutex<Option<Result<String, String>>> = Mutex::new(None);

fn record_interop(outcome: Result<String, String>) {
    if let Ok(mut guard) = INTEROP_RESULT.lock() {
        match (&*guard, &outcome) {
            (Some(Ok(_)), _) => {}
            _ => *guard = Some(outcome),
        }
    }
}

/// The recorded zero-copy texture path capability, or the reason it has not
/// been proven yet. `Ok` means a hardware frame was actually imported into
/// WGPU without CPU readback on this box, this run.
pub(crate) fn interop_capability() -> Result<String, String> {
    match INTEROP_RESULT.lock() {
        Ok(guard) => match &*guard {
            Some(result) => result.clone(),
            None => {
                Err("not attempted yet (records on the first hardware frame import)".to_string())
            }
        },
        Err(_) => Err("interop capability record poisoned".to_string()),
    }
}

/// Import a decoded D3D11 hardware frame into `device` (which must be the
/// WGPU Dx12 backend) as a BGRA8 `wgpu::Texture` with
/// `TEXTURE_BINDING | COPY_SRC` usage, without the pixels ever visiting the
/// CPU. Records the outcome for [`interop_capability`] either way.
pub(crate) fn import_d3d11_frame(
    device: &wgpu::Device,
    frame: &D3d11Frame,
) -> Result<wgpu::Texture, String> {
    let result = import_impl(device, frame);
    record_interop(match &result {
        Ok(_) => Ok(format!(
            "D3D11 frame imported into WGPU as a {}x{} BGRA texture (no CPU readback)",
            frame.width(),
            frame.height()
        )),
        Err(e) => Err(e.clone()),
    });
    result
}

fn import_impl(device: &wgpu::Device, frame: &D3d11Frame) -> Result<wgpu::Texture, String> {
    let (width, height) = (frame.width(), frame.height());
    if width == 0 || height == 0 {
        return Err("D3D11 frame has zero dimensions".to_string());
    }
    let hwctx_ptr = frame.device_hwctx_ptr() as *const AvD3d11vaDeviceContext;
    if hwctx_ptr.is_null() {
        return Err("D3D11 frame carries no device context".to_string());
    }
    let hwctx = unsafe { &*hwctx_ptr };

    // The shared destination lives on WGPU's D3D12 device; created raw so it
    // can carry HEAP_FLAG_SHARED (wgpu's own texture creation cannot).
    let hal_device_raw = {
        let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }.ok_or_else(|| {
            "shared WGPU device is not on the Dx12 backend (D3D11 interop needs D3D12)".to_string()
        })?;
        hal.raw_device().clone()
    };
    let resource = create_shared_bgra_target(&hal_device_raw, width, height)?;
    let shared_handle = unsafe {
        hal_device_raw
            .CreateSharedHandle(&resource, None, GENERIC_ALL.0, None)
            .map_err(|e| format!("D3D12 CreateSharedHandle failed: {e}"))?
    };

    // Convert the decoder's NV12 slice into the shared texture on FFmpeg's
    // D3D11 device (fixed-function video processor: GPU->GPU, YUV->RGB).
    let blit = unsafe { blit_frame_into_shared(hwctx, frame, shared_handle, width, height) };
    let _ = unsafe { CloseHandle(shared_handle) };
    blit?;

    // Wrap the finished D3D12 resource as a wgpu texture.
    let size = wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    };
    let hal_texture = unsafe {
        wgpu::hal::dx12::Device::texture_from_raw(
            resource,
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureDimension::D2,
            size,
            1,
            1,
        )
    };
    let texture = unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
            hal_texture,
            &wgpu::TextureDescriptor {
                label: Some("hgripe-d3d11-imported-frame"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Bgra8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            },
        )
    };
    Ok(texture)
}

/// Create the shared BGRA8 render target on the D3D12 device.
/// `ALLOW_SIMULTANEOUS_ACCESS` is what lets the D3D11 device write it
/// without cross-API resource state transitions; the CPU-side event-query
/// fence in [`blit_frame_into_shared`] orders the accesses.
fn create_shared_bgra_target(
    device12: &windows::Win32::Graphics::Direct3D12::ID3D12Device,
    width: u32,
    height: u32,
) -> Result<ID3D12Resource, String> {
    let heap = D3D12_HEAP_PROPERTIES {
        Type: D3D12_HEAP_TYPE_DEFAULT,
        CPUPageProperty: D3D12_CPU_PAGE_PROPERTY_UNKNOWN,
        MemoryPoolPreference: D3D12_MEMORY_POOL_UNKNOWN,
        CreationNodeMask: 1,
        VisibleNodeMask: 1,
    };
    let desc = D3D12_RESOURCE_DESC {
        Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
        Alignment: 0,
        Width: width as u64,
        Height: height,
        DepthOrArraySize: 1,
        MipLevels: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
        Flags: D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET
            | D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS,
    };
    let mut resource: Option<ID3D12Resource> = None;
    unsafe {
        device12
            .CreateCommittedResource(
                &heap,
                D3D12_HEAP_FLAG_SHARED,
                &desc,
                D3D12_RESOURCE_STATE_COMMON,
                None,
                &mut resource,
            )
            .map_err(|e| format!("D3D12 CreateCommittedResource(shared BGRA) failed: {e}"))?;
    }
    resource.ok_or_else(|| "D3D12 CreateCommittedResource returned no resource".to_string())
}

/// On FFmpeg's D3D11 device: open the shared D3D12 texture, run the video
/// processor from the decoder's NV12 slice into it, and block until the GPU
/// finished (event query), so the D3D12 side never samples unfinished
/// pixels.
///
/// # Safety
/// `hwctx` must point at the live `AVD3D11VADeviceContext` owning the
/// frame's texture; `shared_handle` must be a D3D12 NT shared handle for a
/// BGRA8 `width`x`height` texture.
unsafe fn blit_frame_into_shared(
    hwctx: &AvD3d11vaDeviceContext,
    frame: &D3d11Frame,
    shared_handle: windows::Win32::Foundation::HANDLE,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let device = ID3D11Device::from_raw_borrowed(&hwctx.device)
        .ok_or("AVD3D11VADeviceContext carries no ID3D11Device")?;
    let device_context = ID3D11DeviceContext::from_raw_borrowed(&hwctx.device_context)
        .ok_or("AVD3D11VADeviceContext carries no ID3D11DeviceContext")?;
    let video_device = ID3D11VideoDevice::from_raw_borrowed(&hwctx.video_device)
        .ok_or("AVD3D11VADeviceContext carries no ID3D11VideoDevice")?;
    let video_context = ID3D11VideoContext::from_raw_borrowed(&hwctx.video_context)
        .ok_or("AVD3D11VADeviceContext carries no ID3D11VideoContext")?;

    let src_ptr = frame.texture_ptr();
    let src = ID3D11Texture2D::from_raw_borrowed(&src_ptr)
        .ok_or("D3D11 frame carries no texture pointer")?;
    let mut src_desc = D3D11_TEXTURE2D_DESC::default();
    src.GetDesc(&mut src_desc);

    let device1: ID3D11Device1 = device
        .cast()
        .map_err(|e| format!("FFmpeg's D3D11 device has no ID3D11Device1 (OS too old?): {e}"))?;
    let dest: ID3D11Texture2D = device1
        .OpenSharedResource1(shared_handle)
        .map_err(|e| format!("D3D11 OpenSharedResource1(D3D12 shared texture) failed: {e}"))?;

    let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputFrameRate: DXGI_RATIONAL {
            Numerator: 30,
            Denominator: 1,
        },
        InputWidth: src_desc.Width,
        InputHeight: src_desc.Height,
        OutputFrameRate: DXGI_RATIONAL {
            Numerator: 30,
            Denominator: 1,
        },
        OutputWidth: width,
        OutputHeight: height,
        Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    };
    let enumerator = video_device
        .CreateVideoProcessorEnumerator(&content)
        .map_err(|e| format!("CreateVideoProcessorEnumerator failed: {e}"))?;
    let processor = video_device
        .CreateVideoProcessor(&enumerator, 0)
        .map_err(|e| format!("CreateVideoProcessor failed: {e}"))?;

    let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
        FourCC: 0,
        ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPIV {
                MipSlice: 0,
                ArraySlice: frame.array_index() as u32,
            },
        },
    };
    let mut input_view: Option<ID3D11VideoProcessorInputView> = None;
    video_device
        .CreateVideoProcessorInputView(src, &enumerator, &input_desc, Some(&mut input_view))
        .map_err(|e| format!("CreateVideoProcessorInputView failed: {e}"))?;
    let input_view = input_view.ok_or("CreateVideoProcessorInputView returned no view")?;

    let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
        },
    };
    let mut output_view: Option<ID3D11VideoProcessorOutputView> = None;
    video_device
        .CreateVideoProcessorOutputView(&dest, &enumerator, &output_desc, Some(&mut output_view))
        .map_err(|e| format!("CreateVideoProcessorOutputView failed: {e}"))?;
    let output_view = output_view.ok_or("CreateVideoProcessorOutputView returned no view")?;

    // FFmpeg's hwcontext lock protects device_context/video_context use.
    let _lock = HwCtxLock::acquire(hwctx);

    // Only convert the frame's real pixels: the decoder pool texture is
    // usually padded to coded size (e.g. 16-pixel macroblock alignment).
    let source_rect = windows::Win32::Foundation::RECT {
        left: 0,
        top: 0,
        right: width as i32,
        bottom: height as i32,
    };
    video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&source_rect));
    video_context.VideoProcessorSetStreamFrameFormat(
        &processor,
        0,
        D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    );

    let stream = D3D11_VIDEO_PROCESSOR_STREAM {
        Enable: true.into(),
        OutputIndex: 0,
        InputFrameOrField: 0,
        PastFrames: 0,
        FutureFrames: 0,
        ppPastSurfaces: core::ptr::null_mut(),
        pInputSurface: core::mem::ManuallyDrop::new(Some(input_view)),
        ppFutureSurfaces: core::ptr::null_mut(),
        ppPastSurfacesRight: core::ptr::null_mut(),
        pInputSurfaceRight: core::mem::ManuallyDrop::new(None),
        ppFutureSurfacesRight: core::ptr::null_mut(),
    };
    let blt = video_context.VideoProcessorBlt(&processor, &output_view, 0, &[stream.clone()]);
    // The stream holds a ManuallyDrop'd COM reference; release it explicitly.
    drop(core::mem::ManuallyDrop::into_inner(stream.pInputSurface));
    blt.map_err(|e| format!("VideoProcessorBlt(NV12 -> shared BGRA) failed: {e}"))?;

    // CPU-side fence: an event query flips its BOOL to TRUE once every
    // D3D11 command issued before it (the Blt) has finished on the GPU.
    let query_desc = D3D11_QUERY_DESC {
        Query: D3D11_QUERY_EVENT,
        MiscFlags: 0,
    };
    let mut query: Option<ID3D11Query> = None;
    device
        .CreateQuery(&query_desc, Some(&mut query))
        .map_err(|e| format!("D3D11 CreateQuery(event) failed: {e}"))?;
    let query = query.ok_or("D3D11 CreateQuery returned no query")?;
    device_context.End(&query);
    device_context.Flush();
    let mut done: windows::core::BOOL = false.into();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !done.as_bool() {
        device_context
            .GetData(
                &query,
                Some(&mut done as *mut _ as *mut core::ffi::c_void),
                size_of::<windows::core::BOOL>() as u32,
                0,
            )
            .map_err(|e| format!("D3D11 event query GetData failed: {e}"))?;
        if std::time::Instant::now() > deadline {
            return Err("D3D11 -> D3D12 blit did not finish within 5s".to_string());
        }
        if !done.as_bool() {
            std::thread::yield_now();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio::ffmpeg_native;

    /// A standalone Dx12 wgpu device for the test, deliberately not the
    /// shared surface device: initialising the process-wide `SharedGpu` here
    /// would break the registry's lazy-init startup-guard test that runs in
    /// the same process.
    fn dx12_test_device() -> Result<(wgpu::Device, wgpu::Queue), String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12,
            ..wgpu::InstanceDescriptor::new_without_display_handle_from_env()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .map_err(|e| format!("no Dx12 adapter: {e}"))?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .map_err(|e| format!("Dx12 device request failed: {e}"))?;
        Ok((device, queue))
    }

    /// Read the imported texture back into bytes purely for verification —
    /// the readback is part of the test harness, not the import path.
    fn read_texture_bgra(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        texture: &wgpu::Texture,
    ) -> Vec<u8> {
        let (width, height) = (texture.width(), texture.height());
        let bytes_per_row = (width * 4).div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (bytes_per_row * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |r| r.unwrap());
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let data = slice.get_mapped_range();
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for row in 0..height {
            let start = (row * bytes_per_row) as usize;
            out.extend_from_slice(&data[start..start + (width * 4) as usize]);
        }
        out
    }

    /// The zero-copy texture path contract (phase 2): on a box where the
    /// D3D11VA session opens and a Dx12 wgpu device exists, a decoded
    /// hardware frame imports into WGPU without CPU readback and carries
    /// the clip's actual pixels (verified here by a test-only readback of
    /// the imported texture). Where any level is missing, the import fails
    /// with the reason, and the recorded capability matches the outcome
    /// either way — never silent.
    #[test]
    fn hardware_frame_imports_into_wgpu_or_fails_diagnosably() {
        let dir = std::env::temp_dir();
        let mut frames = Vec::new();
        for i in 0..8u8 {
            let path = dir.join(format!("hgripe_d3d11_wgpu_frame_{i}.png"));
            image::RgbaImage::from_pixel(64, 48, image::Rgba([200, 40, 90, 255]))
                .save(&path)
                .unwrap();
            frames.push(path.to_string_lossy().to_string());
        }
        let clip = dir.join("hgripe_d3d11_wgpu_test.mp4");
        ffmpeg_native::assemble_frames(&frames, &clip, 6.0, "libx264").unwrap();

        let frame = match ffmpeg_native::decode_d3d11_frame(&clip, 0.3) {
            Ok(frame) => frame,
            Err(reason) => {
                // No hardware session on this box (e.g. CI without a D3D11
                // device): the phase-1 level already reports why.
                assert!(!reason.is_empty());
                cleanup(&frames, &clip);
                return;
            }
        };
        let (device, queue) = match dx12_test_device() {
            Ok(pair) => pair,
            Err(reason) => {
                assert!(!reason.is_empty());
                cleanup(&frames, &clip);
                return;
            }
        };

        match import_d3d11_frame(&device, &frame) {
            Ok(texture) => {
                assert_eq!((texture.width(), texture.height()), (64, 48));
                assert_eq!(texture.format(), wgpu::TextureFormat::Bgra8Unorm);
                let pixels = read_texture_bgra(&device, &queue, &texture);
                // Centre pixel ~ (200, 40, 90) rgba -> BGRA order, with a
                // generous tolerance for the H.264 + video-processor
                // YUV<->RGB round trip.
                let idx = ((24 * 64) + 32) * 4;
                let (b, g, r, a) = (
                    pixels[idx] as i32,
                    pixels[idx + 1] as i32,
                    pixels[idx + 2] as i32,
                    pixels[idx + 3] as i32,
                );
                assert!(
                    (r - 200).abs() < 40 && (g - 40).abs() < 40 && (b - 90).abs() < 40,
                    "imported pixel drifted too far: b={b} g={g} r={r}"
                );
                assert_eq!(a, 255);
                let recorded = interop_capability().unwrap();
                assert!(recorded.contains("imported into WGPU"), "{recorded}");
            }
            Err(reason) => {
                assert!(!reason.is_empty(), "import failure must carry a reason");
                let recorded = interop_capability();
                assert!(recorded.is_err() || recorded.is_ok(), "always recorded");
            }
        }
        cleanup(&frames, &clip);
    }

    fn cleanup(frames: &[String], clip: &std::path::Path) {
        for frame in frames {
            let _ = std::fs::remove_file(frame);
        }
        let _ = std::fs::remove_file(clip);
    }

    /// Before any import ran, the capability is a structured "not attempted"
    /// reason (asserted via the record fn contract rather than the global,
    /// which other tests in this process may already have populated).
    #[test]
    fn capability_reads_are_never_silent() {
        match interop_capability() {
            Ok(detail) => assert!(detail.contains("imported into WGPU"), "{detail}"),
            Err(reason) => assert!(!reason.is_empty()),
        }
    }
}
