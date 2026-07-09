#[cfg(feature = "viewport-surface")]
use std::borrow::Cow;
#[cfg(feature = "viewport-surface")]
use std::sync::{Mutex, OnceLock};

#[cfg(feature = "viewport-surface")]
use wgpu::util::DeviceExt;

use super::clip_props::ResolvedClipProps;
use super::working_image::WorkingImage;

#[cfg(feature = "viewport-surface")]
const SHADER: &str = r#"
struct Params {
    dims: vec4<f32>,
    y_bounds: vec4<f32>,
    geometry: vec4<f32>,
    transform: vec4<f32>,
    crop: vec4<f32>,
}

@group(0) @binding(0)
var<storage, read> source: array<vec4<f32>>;

@group(0) @binding(1)
var<storage, read_write> destination: array<vec4<f32>>;

@group(0) @binding(2)
var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn apply_clip_props(@builtin(global_invocation_id) gid: vec3<u32>) {
    let width = u32(params.dims.x);
    let height = u32(params.dims.y);
    if gid.x >= width || gid.y >= height {
        return;
    }

    let index = gid.y * width + gid.x;
    if params.transform.x <= 0.0 || params.transform.w <= 0.0
        || params.crop.x >= params.crop.z || params.crop.y >= params.crop.w {
        destination[index] = vec4<f32>(0.0);
        return;
    }
    let qx = f32(gid.x) + 0.5 - params.geometry.z;
    let qy = f32(gid.y) + 0.5 - params.geometry.w;
    let sx = params.geometry.x
        + params.transform.x * (params.transform.z * qx - params.transform.y * qy);
    let sy = params.geometry.y
        + params.transform.x * (params.transform.y * qx + params.transform.z * qy);

    if sx < params.crop.x || sx >= params.crop.z
        || sy < params.crop.y || sy >= params.crop.w {
        destination[index] = vec4<f32>(0.0);
        return;
    }

    let fx = sx - 0.5;
    let fy = sy - 0.5;
    let ix = i32(floor(fx));
    let iy = i32(floor(fy));
    let ax = fx - floor(fx);
    let ay = fy - floor(fy);

    let min_x = i32(params.dims.z);
    let max_x = i32(params.dims.w);
    let min_y = i32(params.y_bounds.x);
    let max_y = i32(params.y_bounds.y);
    let x0 = u32(clamp(ix, min_x, max_x));
    let x1 = u32(clamp(ix + 1, min_x, max_x));
    let y0 = u32(clamp(iy, min_y, max_y));
    let y1 = u32(clamp(iy + 1, min_y, max_y));

    let p00 = source[y0 * width + x0];
    let p10 = source[y0 * width + x1];
    let p01 = source[y1 * width + x0];
    let p11 = source[y1 * width + x1];
    let top = mix(p00, p10, ax);
    let bottom = mix(p01, p11, ax);
    var sampled = mix(top, bottom, ay);
    sampled.a *= params.transform.w;
    destination[index] = sampled;
}
"#;

#[cfg(feature = "viewport-surface")]
struct GpuClipProps {
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter: String,
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

#[cfg(feature = "viewport-surface")]
impl GpuClipProps {
    fn new() -> Result<Self, String> {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .map_err(|err| format!("no suitable GPU adapter: {err}"))?;
        let info = adapter.get_info();
        let adapter_summary = format!("{} ({:?})", info.name, info.backend);
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("hgripe-clip-props"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            ..Default::default()
        }))
        .map_err(|err| format!("device request failed: {err}"))?;

        let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("clip-props"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(SHADER)),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("clip-props-bgl"),
            entries: &[
                storage_entry(0, true),
                storage_entry(1, false),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
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
            label: Some("clip-props-pl"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("clip-props"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("apply_clip_props"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });
        if let Some(err) = pollster::block_on(error_scope.pop()) {
            return Err(format!("shader compilation failed: {err}"));
        }
        Ok(Self {
            device,
            queue,
            adapter: adapter_summary,
            layout,
            pipeline,
        })
    }

    fn apply(
        &self,
        image: &WorkingImage,
        props: &ResolvedClipProps,
    ) -> Result<WorkingImage, String> {
        if image.width == 0 || image.height == 0 {
            return Ok(image.clone());
        }
        let source: Vec<f32> = image.pixels.iter().map(|&sample| sample as f32).collect();
        let byte_len = (source.len() * std::mem::size_of::<f32>()) as u64;
        let limits = self.device.limits();
        let max_bytes = limits
            .max_storage_buffer_binding_size
            .min(limits.max_buffer_size);
        if byte_len > max_bytes {
            return Err(format!(
                "surface too large for GPU buffers ({byte_len} bytes > device limit {max_bytes})"
            ));
        }

        let source_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("clip-props-source"),
                contents: f32_bytes(&source),
                usage: wgpu::BufferUsages::STORAGE,
            });
        let destination = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("clip-props-destination"),
            size: byte_len,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("clip-props-readback"),
            size: byte_len,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniforms = uniforms(image, props);
        let uniform_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("clip-props-uniforms"),
                contents: f32_bytes(&uniforms),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("clip-props-bind"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: source_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: destination.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform_buffer.as_entire_binding(),
                },
            ],
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("clip-props"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(image.width.div_ceil(16), image.height.div_ceil(16), 1);
        }
        encoder.copy_buffer_to_buffer(&destination, 0, &readback, 0, byte_len);
        self.queue.submit(Some(encoder.finish()));

        let slice = readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|err| format!("GPU device error: {err}"))?;
        rx.recv()
            .map_err(|err| format!("GPU readback failed: {err}"))?
            .map_err(|err| format!("GPU readback failed: {err:?}"))?;
        let pixels = {
            let mapped = slice.get_mapped_range();
            f32_from_bytes(&mapped)
                .iter()
                .map(|sample| sample.round().clamp(0.0, 65535.0) as u16)
                .collect()
        };
        readback.unmap();
        Ok(WorkingImage {
            width: image.width,
            height: image.height,
            pixels,
            space: image.space,
            icc: image.icc.clone(),
        })
    }
}

#[cfg(feature = "viewport-surface")]
fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

#[cfg(feature = "viewport-surface")]
fn uniforms(image: &WorkingImage, props: &ResolvedClipProps) -> [f32; 20] {
    let width = image.width as f64;
    let height = image.height as f64;
    let transform = &props.transform;
    let crop = &props.crop;
    let crop_x0 = width * crop.left_pct / 100.0;
    let crop_x1 = width * (1.0 - crop.right_pct / 100.0);
    let crop_y0 = height * crop.top_pct / 100.0;
    let crop_y1 = height * (1.0 - crop.bottom_pct / 100.0);
    let min_x = crop_x0.floor() as i64;
    let max_x = (crop_x1.ceil() as i64 - 1)
        .max(min_x)
        .clamp(0, image.width as i64 - 1);
    let min_y = crop_y0.floor() as i64;
    let max_y = (crop_y1.ceil() as i64 - 1)
        .max(min_y)
        .clamp(0, image.height as i64 - 1);
    let scale = transform.scale_pct / 100.0;
    let theta = -transform.rotation_deg.to_radians();
    let (sin, cos) = theta.sin_cos();
    [
        image.width as f32,
        image.height as f32,
        min_x.clamp(0, image.width as i64 - 1) as f32,
        max_x as f32,
        min_y.clamp(0, image.height as i64 - 1) as f32,
        max_y as f32,
        0.0,
        0.0,
        (width / 2.0 + transform.anchor.x) as f32,
        (height / 2.0 + transform.anchor.y) as f32,
        (width / 2.0 + transform.position.x) as f32,
        (height / 2.0 + transform.position.y) as f32,
        if scale > 0.0 {
            (1.0 / scale) as f32
        } else {
            0.0
        },
        sin as f32,
        cos as f32,
        (transform.opacity_pct / 100.0) as f32,
        crop_x0 as f32,
        crop_y0 as f32,
        crop_x1 as f32,
        crop_y1 as f32,
    ]
}

#[cfg(feature = "viewport-surface")]
fn f32_bytes(data: &[f32]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), std::mem::size_of_val(data)) }
}

#[cfg(feature = "viewport-surface")]
fn f32_from_bytes(bytes: &[u8]) -> &[f32] {
    assert_eq!(bytes.len() % std::mem::size_of::<f32>(), 0);
    unsafe {
        std::slice::from_raw_parts(
            bytes.as_ptr().cast::<f32>(),
            bytes.len() / std::mem::size_of::<f32>(),
        )
    }
}

#[cfg(feature = "viewport-surface")]
fn gpu() -> &'static Result<Mutex<GpuClipProps>, String> {
    static GPU: OnceLock<Result<Mutex<GpuClipProps>, String>> = OnceLock::new();
    GPU.get_or_init(|| GpuClipProps::new().map(Mutex::new))
}

pub(super) fn apply_clip_props_gpu(
    image: &WorkingImage,
    props: &ResolvedClipProps,
) -> Result<(WorkingImage, String), String> {
    #[cfg(feature = "viewport-surface")]
    {
        return match gpu() {
            Ok(gpu) => match gpu.lock() {
                Ok(gpu) => gpu
                    .apply(image, props)
                    .map(|image| (image, gpu.adapter.clone())),
                Err(_) => Err("GPU clip-property compositor lock poisoned".to_string()),
            },
            Err(reason) => Err(reason.clone()),
        };
    }
    #[cfg(not(feature = "viewport-surface"))]
    {
        let _ = (image, props);
        Err("GPU backend not compiled in (viewport-surface feature disabled)".to_string())
    }
}
