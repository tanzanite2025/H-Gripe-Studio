// Texture-in/texture-out GPU grading on a caller-owned device: the video
// zero-copy route runs the same generated compute plan as [`GpuGrader`],
// but the surface never round-trips through CPU buffers — an ingress pass
// loads the source texture's texels into the plan's `state` buffer, the
// doc's compiled passes run, and an egress pass stores the graded result
// into a storage texture the caller then presents. No readback, no upload.
//
// The grader borrows the device per call (the app's shared presentation
// device is process-global and never recreated), caches the compiled plan
// per (doc, shape, space) like `GpuGrader`, and reuses the state/work
// buffers across frames of the same shape.

use std::borrow::Cow;

use crate::doc::GradeDoc;
use crate::surface::GradeSpace;

use super::wgsl::{build_plan, Step};
use super::{doc_key, storage_entry, GpuError};

// Ingress: load the source texture's texels into the plan's interleaved
// f32 `state` buffer. `textureLoad` returns RGBA regardless of the
// texture's channel order (BGRA imports included), values verbatim
// (non-sRGB formats), which is exactly the gamma-encoded working surface
// the kernel expects.
const INGRESS_SHADER: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> state: array<f32>;

@compute @workgroup_size(16, 16)
fn ingress(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(src);
    if (gid.x >= dims.x || gid.y >= dims.y) {
        return;
    }
    let px = textureLoad(src, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
    let i = (gid.y * dims.x + gid.x) * 4u;
    state[i] = px.r;
    state[i + 1u] = px.g;
    state[i + 2u] = px.b;
    state[i + 3u] = px.a;
}
"#;

// Egress: store the graded `state` buffer into the destination storage
// texture, clamped to 0..1 — the kernel's single quantisation point, same
// contract as `GradeSurface::to_rgba16`.
const EGRESS_SHADER: &str = r#"
@group(0) @binding(0) var<storage, read> state: array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(16, 16)
fn egress(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(dst);
    if (gid.x >= dims.x || gid.y >= dims.y) {
        return;
    }
    let i = (gid.y * dims.x + gid.x) * 4u;
    let px = vec4<f32>(state[i], state[i + 1u], state[i + 2u], state[i + 3u]);
    textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), clamp(px, vec4<f32>(0.0), vec4<f32>(1.0)));
}
"#;

/// Doc-independent ingress/egress pipelines, compiled once per grader.
struct Io {
    ingress: wgpu::ComputePipeline,
    ingress_layout: wgpu::BindGroupLayout,
    egress: wgpu::ComputePipeline,
    egress_layout: wgpu::BindGroupLayout,
}

/// The compiled plan plus the buffers sized for its shape, reused across
/// frames of the same (doc, shape, space).
struct CachedTex {
    key: u64,
    w: u32,
    h: u32,
    space: GradeSpace,
    pipelines: Vec<(wgpu::ComputePipeline, String)>,
    steps: Vec<Step>,
    bind: wgpu::BindGroup,
    state: wgpu::Buffer,
    work_a: wgpu::Buffer,
    n: u32,
}

/// A reusable texture-to-texture GPU grading context on a caller-owned
/// device/queue. Construct once and reuse across frames: the compiled plan
/// and its buffers are cached per (doc, shape, space).
pub struct TextureGrader {
    io: Option<Io>,
    cached: Option<CachedTex>,
}

impl Default for TextureGrader {
    fn default() -> Self {
        Self::new()
    }
}

impl TextureGrader {
    pub fn new() -> Self {
        Self {
            io: None,
            cached: None,
        }
    }

    /// Run `doc` over `src` (a sampleable texture holding gamma-encoded
    /// `space` pixels) into `dst` (an `rgba8unorm` storage texture of the
    /// same size), entirely on the GPU: no CPU readback, no upload. The
    /// submitted work is ordered on `queue`, so a subsequent render pass
    /// sampling `dst` on the same queue sees the graded pixels.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_texture(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        doc: &GradeDoc,
        src: &wgpu::TextureView,
        dst: &wgpu::TextureView,
        w: u32,
        h: u32,
        space: GradeSpace,
    ) -> Result<(), GpuError> {
        if w == 0 || h == 0 {
            return Ok(());
        }
        let limits = device.limits();
        let surface_bytes = u64::from(w) * u64::from(h) * 16;
        let max_bytes =
            u64::from(limits.max_storage_buffer_binding_size).min(limits.max_buffer_size);
        if surface_bytes > max_bytes {
            return Err(GpuError::SurfaceTooLarge {
                bytes: surface_bytes,
                max: max_bytes,
            });
        }
        self.ensure_io(device)?;
        self.ensure_plan(device, doc, w, h, space)?;
        let io = self.io.as_ref().expect("io built");
        let cached = self.cached.as_ref().expect("plan built");

        let ingress_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("grade-tex-ingress"),
            layout: &io.ingress_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: cached.state.as_entire_binding(),
                },
            ],
        });
        let egress_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("grade-tex-egress"),
            layout: &io.egress_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: cached.state.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(dst),
                },
            ],
        });

        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        let tiles = (w.div_ceil(16), h.div_ceil(16));
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
            pass.set_pipeline(&io.ingress);
            pass.set_bind_group(0, &ingress_bind, &[]);
            pass.dispatch_workgroups(tiles.0, tiles.1, 1);
        }
        let groups = cached.n.div_ceil(256);
        let work_bytes = u64::from(cached.n) * 16;
        for step in &cached.steps {
            match step {
                Step::CopyStateToWorkA => {
                    encoder.copy_buffer_to_buffer(&cached.state, 0, &cached.work_a, 0, work_bytes);
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
                    pass.set_bind_group(0, &cached.bind, &[]);
                    pass.dispatch_workgroups(groups, 1, 1);
                }
            }
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
            pass.set_pipeline(&io.egress);
            pass.set_bind_group(0, &egress_bind, &[]);
            pass.dispatch_workgroups(tiles.0, tiles.1, 1);
        }
        queue.submit(Some(encoder.finish()));
        Ok(())
    }

    fn ensure_io(&mut self, device: &wgpu::Device) -> Result<(), GpuError> {
        if self.io.is_some() {
            return Ok(());
        }
        let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let ingress_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("grade-tex-ingress"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                storage_entry(1, false),
            ],
        });
        let egress_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("grade-tex-egress"),
            entries: &[
                storage_entry(0, true),
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
            ],
        });
        let pipeline = |shader: &str, layout: &wgpu::BindGroupLayout, entry: &str| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(entry),
                source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(shader)),
            });
            let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(entry),
                bind_group_layouts: &[Some(layout)],
                immediate_size: 0,
            });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&pl),
                module: &module,
                entry_point: Some(entry),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                cache: None,
            })
        };
        let ingress = pipeline(INGRESS_SHADER, &ingress_layout, "ingress");
        let egress = pipeline(EGRESS_SHADER, &egress_layout, "egress");
        if let Some(err) = pollster::block_on(error_scope.pop()) {
            return Err(GpuError::ShaderCompilation(err.to_string()));
        }
        self.io = Some(Io {
            ingress,
            ingress_layout,
            egress,
            egress_layout,
        });
        Ok(())
    }

    // Build (or reuse) the compiled plan + its buffers for `doc` at the
    // given shape. Mirrors `GpuGrader::ensure_plan`, plus the state/work
    // buffers are cached with the plan so replaying frames allocates
    // nothing.
    fn ensure_plan(
        &mut self,
        device: &wgpu::Device,
        doc: &GradeDoc,
        w: u32,
        h: u32,
        space: GradeSpace,
    ) -> Result<(), GpuError> {
        let key = doc_key(doc);
        if let Some(c) = &self.cached {
            if c.key == key && c.w == w && c.h == h && c.space == space {
                return Ok(());
            }
        }
        let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let plan = build_plan(doc, w, h, space);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("grade-tex"),
            source: wgpu::ShaderSource::Wgsl(Cow::Owned(plan.shader)),
        });
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("grade-tex-bgl"),
            entries: &[
                storage_entry(0, false),
                storage_entry(1, false),
                storage_entry(2, false),
                storage_entry(3, true),
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("grade-tex-pl"),
            bind_group_layouts: &[Some(&bind_layout)],
            immediate_size: 0,
        });
        let mut pipelines = Vec::new();
        for step in &plan.steps {
            if let Step::Dispatch(entry) = step {
                if pipelines.iter().any(|(_, n): &(_, String)| n == entry) {
                    continue;
                }
                let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
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
        let mut table_data = plan.tables;
        if table_data.is_empty() {
            table_data.push(0.0);
        }
        let tables = {
            use wgpu::util::DeviceExt;
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("grade-tex-tables"),
                contents: super::bytemuck_cast(&table_data),
                usage: wgpu::BufferUsages::STORAGE,
            })
        };
        let n = w * h;
        let work_bytes = u64::from(n) * 16;
        let buffer = |label: &str| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: work_bytes,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let state = buffer("grade-tex-state");
        let work_a = buffer("grade-tex-work-a");
        let work_b = buffer("grade-tex-work-b");
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("grade-tex-bind"),
            layout: &bind_layout,
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
                    resource: tables.as_entire_binding(),
                },
            ],
        });
        if let Some(err) = pollster::block_on(error_scope.pop()) {
            self.cached = None;
            return Err(GpuError::ShaderCompilation(err.to_string()));
        }
        self.cached = Some(CachedTex {
            key,
            w,
            h,
            space,
            pipelines,
            steps: plan.steps,
            bind,
            state,
            work_a,
            n,
        });
        Ok(())
    }
}
