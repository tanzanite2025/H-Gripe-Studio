// The optional GPU backend (feature `gpu`): a wgpu compute runner that
// executes a `GradeDoc` over a surface on the GPU. The maths mirrors the
// CPU reference path in `ops.rs` / `composite.rs` / `doc.rs` — the CPU
// path stays the golden reference (bit-identical, per the design doc), and
// this backend is validated against it with tolerances in `tests/gpu.rs`.
// It exists to serve real-time preview and future frame-by-frame video
// rendering, and the generated WGSL (`wgsl.rs`) is reusable by a frontend
// WebGPU path later.
//
// A [`GpuGrader`] owns a device/queue and caches the compiled pipeline per
// (doc, surface shape) so replaying one doc over many frames pays codegen +
// shader compilation once. `apply` is a blocking, synchronous call
// (`pollster`) so it slots into the existing CPU-shaped API.

mod wgsl;

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use wgpu::util::DeviceExt;

use crate::doc::GradeDoc;
use crate::surface::{GradeSpace, GradeSurface};
use wgsl::{build_plan, Step};

/// A reusable GPU grading context: one device/queue plus a one-entry
/// compiled-plan cache. Construct once (device creation is expensive) and
/// reuse across frames.
pub struct GpuGrader {
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Human-readable adapter description (name + backend), for capability
    /// and device reports.
    adapter: String,
    cached: Option<Cached>,
}

struct Cached {
    key: u64,
    w: u32,
    h: u32,
    space: GradeSpace,
    pipelines: Vec<(wgpu::ComputePipeline, String)>,
    steps: Vec<Step>,
    tables: wgpu::Buffer,
    bind_layout: wgpu::BindGroupLayout,
    /// Pixel count the work buffers were sized for.
    n: u32,
}

/// Why a GPU grade could not run.
#[derive(Debug)]
pub enum GpuError {
    /// No GPU adapter/device was available (headless CI, no drivers, …).
    /// Callers should fall back to the CPU path.
    NoAdapter,
    /// The device was lost or a buffer mapping failed.
    Device(String),
}

impl std::fmt::Display for GpuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GpuError::NoAdapter => write!(f, "no suitable GPU adapter"),
            GpuError::Device(e) => write!(f, "GPU device error: {e}"),
        }
    }
}

impl std::error::Error for GpuError {}

impl GpuGrader {
    /// Create a grader on the default high-performance adapter. Returns
    /// [`GpuError::NoAdapter`] when no GPU is available so the caller can
    /// fall back to the CPU path.
    pub fn new() -> Result<Self, GpuError> {
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .map_err(|_| GpuError::NoAdapter)?;
        let info = adapter.get_info();
        let adapter_summary = format!("{} ({:?})", info.name, info.backend);
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("hgripe-grade"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            ..Default::default()
        }))
        .map_err(|e| GpuError::Device(e.to_string()))?;
        Ok(Self {
            device,
            queue,
            adapter: adapter_summary,
            cached: None,
        })
    }

    /// The adapter this grader runs on, e.g. `NVIDIA GeForce RTX 4090 (Vulkan)`.
    pub fn adapter_summary(&self) -> &str {
        &self.adapter
    }

    /// Run `doc` over `surface` in place on the GPU. Recompiles the plan
    /// when the doc or surface shape changes; otherwise reuses the cached
    /// pipeline. The result matches the CPU [`crate::apply`] within f32
    /// tolerance (see `tests/gpu.rs`), not bit-for-bit.
    pub fn apply(&mut self, doc: &GradeDoc, surface: &mut GradeSurface) -> Result<(), GpuError> {
        if surface.w == 0 || surface.h == 0 {
            return Ok(());
        }
        self.ensure_plan(doc, surface);
        let cached = self.cached.as_ref().expect("plan built");

        let bytes = bytemuck_cast(&surface.data);
        let state = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("state"),
                contents: bytes,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
            });
        let work_bytes = (cached.n as u64) * 16;
        let work_a = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("work_a"),
            size: work_bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let work_b = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("work_b"),
            size: work_bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: bytes.len() as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("grade-bind"),
            layout: &cached.bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: state.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: work_a.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: work_b.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: cached.tables.as_entire_binding(),
                },
            ],
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        let groups = cached.n.div_ceil(256);
        for step in &cached.steps {
            match step {
                Step::CopyStateToWorkA => {
                    encoder.copy_buffer_to_buffer(&state, 0, &work_a, 0, work_bytes);
                }
                Step::Dispatch(entry) => {
                    let pipeline = &cached
                        .pipelines
                        .iter()
                        .find(|(_, name)| name == entry)
                        .expect("pipeline for entry")
                        .0;
                    let mut pass =
                        encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                    pass.set_pipeline(pipeline);
                    pass.set_bind_group(0, &bind, &[]);
                    pass.dispatch_workgroups(groups, 1, 1);
                }
            }
        }
        encoder.copy_buffer_to_buffer(&state, 0, &readback, 0, bytes.len() as u64);
        self.queue.submit(Some(encoder.finish()));

        let slice = readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|e| GpuError::Device(e.to_string()))?;
        rx.recv()
            .map_err(|e| GpuError::Device(e.to_string()))?
            .map_err(|e| GpuError::Device(format!("{e:?}")))?;
        {
            let view = slice.get_mapped_range();
            let out: &[f32] = bytemuck_cast_from(&view);
            surface.data.copy_from_slice(out);
        }
        readback.unmap();
        Ok(())
    }

    // Build (or reuse) the compiled plan for `doc` at `surface`'s shape.
    fn ensure_plan(&mut self, doc: &GradeDoc, surface: &GradeSurface) {
        let key = doc_key(doc);
        if let Some(c) = &self.cached {
            if c.key == key && c.w == surface.w && c.h == surface.h && c.space == surface.space {
                return;
            }
        }
        let plan = build_plan(doc, surface.w, surface.h, surface.space);
        if std::env::var("HGRIPE_GPU_DUMP_WGSL").is_ok() {
            eprintln!("{}", plan.shader);
        }
        let module = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("grade"),
                source: wgpu::ShaderSource::Wgsl(Cow::Owned(plan.shader)),
            });
        let bind_layout = self
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("grade-bgl"),
                entries: &[
                    storage_entry(0, false),
                    storage_entry(1, false),
                    storage_entry(2, false),
                    storage_entry(3, true),
                ],
            });
        let layout = self
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("grade-pl"),
                bind_group_layouts: &[Some(&bind_layout)],
                immediate_size: 0,
            });
        let mut pipelines = Vec::new();
        for step in &plan.steps {
            if let Step::Dispatch(entry) = step {
                if pipelines.iter().any(|(_, n): &(_, String)| n == entry) {
                    continue;
                }
                let pipeline =
                    self.device
                        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                            label: Some(entry),
                            layout: Some(&layout),
                            module: &module,
                            entry_point: Some(entry),
                            compilation_options: wgpu::PipelineCompilationOptions::default(),
                            cache: None,
                        });
                pipelines.push((pipeline, entry.clone()));
            }
        }
        // A zero-length storage buffer is invalid; pad the (possibly empty)
        // table blob to one element.
        let mut tables = plan.tables;
        if tables.is_empty() {
            tables.push(0.0);
        }
        let tables = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("tables"),
                contents: bytemuck_cast(&tables),
                usage: wgpu::BufferUsages::STORAGE,
            });
        self.cached = Some(Cached {
            key,
            w: surface.w,
            h: surface.h,
            space: surface.space,
            pipelines,
            steps: plan.steps,
            tables,
            bind_layout,
            n: surface.w * surface.h,
        });
    }
}

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

// A stable hash of the doc — the plan-cache key. Any op/param/layer change
// recompiles; replaying an unchanged doc reuses the pipeline.
fn doc_key(doc: &GradeDoc) -> u64 {
    let mut h = DefaultHasher::new();
    format!("{doc:?}").hash(&mut h);
    h.finish()
}

// f32 slice <-> byte slice. The surface data is a plain `Vec<f32>`, and
// wgpu wants `&[u8]`; f32 has no padding/invalid bit patterns so this is a
// sound reinterpret without pulling in the `bytemuck` dependency.
fn bytemuck_cast(data: &[f32]) -> &[u8] {
    // SAFETY: f32 is `Copy` with no padding; length scales by 4.
    unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), std::mem::size_of_val(data)) }
}

fn bytemuck_cast_from(bytes: &[u8]) -> &[f32] {
    assert_eq!(bytes.len() % 4, 0, "f32 readback length");
    assert_eq!(
        bytes.as_ptr() as usize % std::mem::align_of::<f32>(),
        0,
        "alignment"
    );
    // SAFETY: the mapped range is 4-byte aligned (checked above) and holds
    // f32s written as bytes; every bit pattern is a valid f32.
    unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<f32>(), bytes.len() / 4) }
}
