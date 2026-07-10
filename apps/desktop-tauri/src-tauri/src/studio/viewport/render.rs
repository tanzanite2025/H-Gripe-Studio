use super::*;

fn grade_backend_report(backend: crate::studio::GradeBackend) -> ViewportBackend {
    ViewportBackend {
        requested: "auto".to_string(),
        actual: backend.name.to_string(),
        detail: None,
        fallback_reason: backend.fallback_reason,
        decode_processing_time_ms: None,
        props_backend: None,
        props_backend_detail: None,
        props_fallback_reason: None,
        props_processing_time_ms: None,
        grade_processing_time_ms: None,
    }
}

/// Render the viewport's frame to 8-bit sRGB pixels (no transport encode) —
/// the shared ingress of both egress paths: PNG transport and native surface
/// presentation.
pub(super) fn viewport_render_rgba(viewport_id: &str) -> Result<RenderedRgba, String> {
    viewport_render_rgba_with_overlay(viewport_id, true)
}

pub(super) fn viewport_render_rgba_with_overlay(
    viewport_id: &str,
    include_overlay_scene: bool,
) -> Result<RenderedRgba, String> {
    let id = parse_id(viewport_id)?;
    let (
        target,
        width,
        height,
        grade_doc,
        view,
        temporal_denoise,
        mask_overlay,
        overlay_scene,
        clip_props,
    ) = {
        let mut map = viewports()
            .lock()
            .map_err(|_| "viewport registry poisoned")?;
        let state = map
            .get_mut(&id)
            .ok_or_else(|| format!("unknown viewport id: {viewport_id}"))?;
        (
            state.target.clone(),
            state.width,
            state.height,
            state.grade_doc.clone(),
            state.view,
            state.temporal_denoise,
            state.mask_overlay.clone(),
            if include_overlay_scene {
                state.overlay_scene.clone()
            } else {
                None
            },
            // Resolve at the stored clip-local time; identity resolves
            // vanish here so a static default document costs nothing.
            state
                .clip_props
                .as_mut()
                .map(|(_, evaluator)| evaluator.resolve(state.clip_props_time))
                .filter(|resolved| !resolved.is_identity()),
        )
    };
    let target = target.ok_or_else(|| format!("viewport {viewport_id} has no target"))?;
    match target {
        ViewportTarget::Image { resource_id } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            render_image_path(
                id,
                &entry.path,
                width,
                height,
                grade_doc,
                view,
                mask_overlay.as_deref(),
                overlay_scene.as_deref(),
                clip_props.as_ref(),
            )
        }
        ViewportTarget::ImageLayer { asset_id, layer_id } => {
            // Layer artifacts resolve through the layered asset registry —
            // the same reference-not-pixels contract as image resources.
            let path = layered_asset_layer_path(&asset_id, &layer_id)?;
            render_image_path(
                id,
                &path,
                width,
                height,
                grade_doc,
                view,
                mask_overlay.as_deref(),
                overlay_scene.as_deref(),
                None,
            )
        }
        ViewportTarget::ImageComposite {
            resource_id,
            document,
            document_key,
            document_width,
            document_height,
        } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            render_image_composite_path(
                id,
                &entry.path,
                &document,
                &document_key,
                document_width,
                document_height,
                width,
                height,
                grade_doc,
                view,
                mask_overlay.as_deref(),
                overlay_scene.as_deref(),
            )
        }
        #[cfg(feature = "native-ffmpeg")]
        ViewportTarget::VideoFrame {
            resource_id,
            time_sec,
            ..
        } => {
            let entry = resource::get(&resource_id)
                .ok_or_else(|| format!("unknown resource id: {resource_id}"))?;
            render_video_path(
                id,
                &entry.path,
                time_sec,
                width,
                height,
                grade_doc,
                view,
                temporal_denoise,
                overlay_scene.as_deref(),
                clip_props.as_ref(),
            )
        }
        #[cfg(not(feature = "native-ffmpeg"))]
        ViewportTarget::VideoFrame { .. } => {
            Err("video frame targets require the native media engine".to_string())
        }
        ViewportTarget::VideoClip {
            timeline_id,
            clip_id,
            time_sec,
            ..
        } => {
            // Clips resolve through the timeline registry; the host maps the
            // timeline playhead to clip-local source time.
            let clip = timeline_clip(&timeline_id, &clip_id)?;
            if clip.kind == "still" {
                return render_image_path(
                    id,
                    &clip.path,
                    width,
                    height,
                    grade_doc,
                    view,
                    None,
                    overlay_scene.as_deref(),
                    clip_props.as_ref(),
                );
            }
            let source_time = (time_sec - clip.start_sec).clamp(0.0, clip.duration_sec);
            #[cfg(feature = "native-ffmpeg")]
            {
                render_video_path(
                    id,
                    &clip.path,
                    source_time,
                    width,
                    height,
                    grade_doc,
                    view,
                    temporal_denoise,
                    overlay_scene.as_deref(),
                    clip_props.as_ref(),
                )
            }
            #[cfg(not(feature = "native-ffmpeg"))]
            {
                let _ = source_time;
                Err("video clip targets require the native media engine".to_string())
            }
        }
        ViewportTarget::NodeOutput {
            node_id,
            output_port,
        } => {
            // Node outputs resolve through the node output registry — the
            // same reference-not-pixels contract as the other targets.
            let path = node_output_path(&node_id, output_port.as_deref())?;
            render_image_path(
                id,
                &path,
                width,
                height,
                grade_doc,
                view,
                mask_overlay.as_deref(),
                overlay_scene.as_deref(),
                None,
            )
        }
    }
}

/// The video zero-copy presentation fast path (GPU_DEVICE_STRATEGY_PLAN
/// phase 3): when the viewport's video target explicitly opted in with
/// `decodeDevice: "gpu"` (no denoise, no overlay), decode it as a D3D11 GPU
/// texture and present it on the native surface through the WGPU import —
/// no CPU readback, no upload, no PNG. Zoom/pan views present as GPU crops
/// of the imported texture (the same crop mechanism as the zoom/pan fast
/// path), and a grade doc runs as a wgpu compute plan directly on the
/// imported texture, so views and grades stay on the zero-copy path.
/// `Some((w, h))` means the frame is on the surface; `None` means the
/// caller runs the CPU render, with the reason on stderr and the import
/// outcome in the device registry (never silent).
#[cfg(all(windows, feature = "viewport-surface", feature = "native-ffmpeg"))]
pub(super) fn try_present_hw_video_frame(viewport_id: &str) -> Option<(u32, u32)> {
    let Ok(id) = parse_id(viewport_id) else {
        return None;
    };
    let (target, grade_doc, view, temporal_denoise, overlay_scene) = {
        let map = viewports().lock().ok()?;
        let state = map.get(&id)?;
        (
            state.target.clone()?,
            state.grade_doc.clone(),
            state.view,
            state.temporal_denoise,
            state.overlay_scene.clone(),
        )
    };
    let (path, time_sec) = match &target {
        ViewportTarget::VideoFrame {
            resource_id,
            time_sec,
            decode_device,
        } if decode_device.as_deref() == Some("gpu") => {
            (resource::get(resource_id)?.path.clone(), *time_sec)
        }
        ViewportTarget::VideoClip {
            timeline_id,
            clip_id,
            time_sec,
            decode_device,
        } if decode_device.as_deref() == Some("gpu") => {
            let clip = timeline_clip(timeline_id, clip_id).ok()?;
            if clip.kind == "still" {
                return None;
            }
            let source_time = (*time_sec - clip.start_sec).clamp(0.0, clip.duration_sec);
            (clip.path.clone(), source_time)
        }
        _ => return None,
    };
    // Denoise and overlays still need the CPU render. The view and the
    // grade doc are not gates — zoom/pan present as GPU crops of the
    // imported texture, and the grade runs as a wgpu compute plan on it.
    if temporal_denoise > 0.0 || overlay_scene.is_some() {
        return None;
    }
    // An unparseable doc falls through to the CPU render, which surfaces
    // the parse error to the caller.
    let doc = parse_grade_doc(grade_doc.as_ref()).ok()?;
    let grade = (!doc.layers.is_empty()).then_some(&doc);
    let result = (|| -> Result<(u32, u32), String> {
        // Continuous playback pacing: reuse the viewport's persistent decode
        // session so a forward playhead step decodes sequentially (no reopen,
        // no keyframe seek). The lock is held across the decode — sessions
        // are strictly one-at-a-time.
        let mut sessions = hw_sessions()
            .lock()
            .map_err(|_| "hardware session registry poisoned".to_string())?;
        let session = match sessions.entry(id) {
            std::collections::hash_map::Entry::Occupied(entry)
                if entry.get().path() == std::path::Path::new(&path) =>
            {
                entry.into_mut()
            }
            std::collections::hash_map::Entry::Occupied(entry) => {
                let slot = entry.into_mut();
                *slot = crate::studio::ffmpeg_native::D3d11PlaybackSession::open(
                    std::path::Path::new(&path),
                )?;
                slot
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(crate::studio::ffmpeg_native::D3d11PlaybackSession::open(
                    std::path::Path::new(&path),
                )?)
            }
        };
        let frame = session.frame_near(time_sec)?;
        let size = (frame.width(), frame.height());
        crate::commands::viewport_surface::present_hw_frame(
            viewport_id,
            &frame,
            grade,
            (view.zoom, view.pan_x, view.pan_y),
        )?;
        Ok(size)
    })();
    match result {
        Ok(size) => Some(size),
        Err(reason) => {
            eprintln!("[viewport] zero-copy present fell back for {viewport_id}: {reason}");
            // Never leave a possibly-broken session behind: the next opted-in
            // request reopens fresh.
            if let Ok(mut sessions) = hw_sessions().lock() {
                sessions.remove(&id);
            }
            None
        }
    }
}

/// Render one video source frame at the viewport's size, applying its grade
/// doc and view. Graded/viewed frames decode through the native media engine
/// with the proxy cached per viewport keyed by path + timestamp + size, so
/// grading or panning a paused frame re-runs only crop + kernel; ungraded
/// frames resolve through the playback engine — dedicated decode thread,
/// bounded warm frame cache, latest-wins coalescing — then present through
/// the cached proxy pipeline.
#[cfg(feature = "native-ffmpeg")]
#[allow(clippy::too_many_arguments)]
fn render_video_path(
    id: u64,
    path: &str,
    time_sec: f64,
    width: u32,
    height: u32,
    grade_doc: Option<Value>,
    view: ViewportView,
    temporal_denoise: f32,
    overlay_scene: Option<&OverlayScene>,
    clip_props: Option<&ResolvedClipProps>,
) -> Result<RenderedRgba, String> {
    let size = width.max(height).clamp(64, 2048);
    if grade_doc.is_some()
        || !view.is_identity()
        || temporal_denoise > 0.0
        || overlay_scene.is_some()
        || clip_props.is_some()
    {
        let doc = parse_grade_doc(grade_doc.as_ref())?;
        let detail = proxy_detail_size(size, view);
        let key = ProxyKey {
            path: path.to_string(),
            time_bits: Some(time_sec.to_bits()),
            size: detail,
        };
        let decode_started = Instant::now();
        let (proxy, source_dims) = cached_proxy_with_dims(id, key, || {
            crate::studio::decode_video_srgb_proxy_with_dims(
                std::path::Path::new(path),
                time_sec,
                detail,
            )
        })?;
        let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
        let (proxy, props_backend) = apply_clip_props_to_proxy(proxy, source_dims, clip_props);
        let source = if view.is_identity() {
            None
        } else {
            Some(crop_view(&proxy, view))
        };
        let mut surface = crate::studio::srgb_proxy_surface(source.as_ref().unwrap_or(&proxy))?;
        let grade_started = Instant::now();
        let backend = crate::studio::apply_grade_doc(&doc, &mut surface);
        let grade_ms = grade_started.elapsed().as_secs_f64() * 1000.0;
        apply_temporal(id, path, time_sec, &mut surface, temporal_denoise)?;
        if let Some(scene) = overlay_scene {
            // Stroked last: guides sit above the graded frame.
            composite_overlay_scene(&mut surface, scene, proxy.dimensions(), view);
        }
        let image = crate::studio::surface_to_rgba(&surface)?;
        return Ok(RenderedRgba {
            image: Arc::new(image),
            backend: grade_backend_report(backend)
                .with_clip_props(props_backend)
                .with_stage_timings(decode_ms, Some(grade_ms)),
            view,
        });
    }
    let poster_dir = crate::cache_subdir(".posters")?;
    let frame = crate::studio::video_engine::scrub_frame(
        &poster_dir,
        std::path::Path::new(path),
        time_sec,
    )?;
    let key = ProxyKey {
        path: path.to_string(),
        time_bits: Some(time_sec.to_bits()),
        size,
    };
    let decode_started = Instant::now();
    let proxy = cached_proxy(id, key, || load_image_srgb_proxy(&frame, size))?;
    let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
    Ok(RenderedRgba {
        image: proxy,
        backend: cpu_backend().with_stage_timings(decode_ms, None),
        view,
    })
}

/// Run the clip property raster over a decoded proxy. `source_dims` are the
/// source's full-resolution dimensions: position/anchor are authored in
/// source pixels, so they scale by the proxy ratio before the pass — the
/// preview then composes identically to the full-resolution export.
fn apply_clip_props_to_proxy(
    proxy: Arc<RgbaImage>,
    source_dims: (u32, u32),
    clip_props: Option<&ResolvedClipProps>,
) -> (Arc<RgbaImage>, Option<ClipPropsBackend>) {
    let Some(props) = clip_props else {
        return (proxy, None);
    };
    let ratio = if source_dims.0 > 0 {
        proxy.width() as f64 / source_dims.0 as f64
    } else {
        1.0
    };
    let (image, backend) =
        apply_clip_props_srgb_proxy_preferred(&proxy, &props.scaled_coords(ratio));
    (Arc::new(image), Some(backend))
}

fn render_image_composite_path(
    id: u64,
    path: &str,
    document: &Value,
    _document_key: &str,
    document_width: u32,
    document_height: u32,
    width: u32,
    height: u32,
    grade_doc: Option<Value>,
    view: ViewportView,
    mask_overlay: Option<&MaskOverlay>,
    overlay_scene: Option<&OverlayScene>,
) -> Result<RenderedRgba, String> {
    let size = width.max(height).clamp(64, 2048);
    let detail = if grade_doc.is_some()
        || !view.is_identity()
        || mask_overlay.is_some()
        || overlay_scene.is_some()
    {
        proxy_detail_size(size, view)
    } else {
        size
    };
    let key = ProxyKey {
        path: path.to_string(),
        time_bits: None,
        size: detail,
    };
    let proxy = cached_proxy(id, key, || {
        load_image_srgb_proxy(std::path::Path::new(path), detail)
    })?;
    let mut image = crate::studio::image_document::composite_image_document(
        &proxy,
        document,
        document_width.max(1),
        document_height.max(1),
    )?;
    let full_dims = image.dimensions();
    if !view.is_identity() {
        image = crop_view(&image, view);
    }
    if grade_doc.is_some() || mask_overlay.is_some() || overlay_scene.is_some() {
        let doc = parse_grade_doc(grade_doc.as_ref())?;
        let mut surface = crate::studio::srgb_proxy_surface(&image)?;
        let backend = crate::studio::apply_grade_doc(&doc, &mut surface);
        if let Some(overlay) = mask_overlay {
            composite_mask_overlay(&mut surface, overlay, full_dims, view);
        }
        if let Some(scene) = overlay_scene {
            composite_overlay_scene(&mut surface, scene, full_dims, view);
        }
        image = crate::studio::surface_to_rgba(&surface)?;
        return Ok(RenderedRgba {
            image: Arc::new(image),
            backend: grade_backend_report(backend),
            view,
        });
    }
    Ok(RenderedRgba {
        image: Arc::new(image),
        backend: cpu_backend(),
        view,
    })
}

/// Render one still-image source (an image resource or a layer artifact) at
/// the viewport's size, applying its grade doc, view and mask overlay. The
/// decoded sRGB proxy is cached on the viewport keyed by path + size, so a
/// slider drag or a pan/zoom tick re-runs only crop + kernel.
fn render_image_path(
    id: u64,
    path: &str,
    width: u32,
    height: u32,
    grade_doc: Option<Value>,
    view: ViewportView,
    mask_overlay: Option<&MaskOverlay>,
    overlay_scene: Option<&OverlayScene>,
    clip_props: Option<&ResolvedClipProps>,
) -> Result<RenderedRgba, String> {
    let size = width.max(height).clamp(64, 2048);
    if grade_doc.is_some()
        || !view.is_identity()
        || mask_overlay.is_some()
        || overlay_scene.is_some()
        || clip_props.is_some()
    {
        // Graded and/or viewed frame: run the grading kernel (identity when
        // no doc is set) over the view window of the source's sRGB proxy.
        let doc = parse_grade_doc(grade_doc.as_ref())?;
        let detail = proxy_detail_size(size, view);
        let key = ProxyKey {
            path: path.to_string(),
            time_bits: None,
            size: detail,
        };
        let decode_started = Instant::now();
        let (proxy, source_dims) = cached_proxy_with_dims(id, key, || {
            load_image_srgb_proxy_with_dims(std::path::Path::new(path), detail)
        })?;
        let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
        let (proxy, props_backend) = apply_clip_props_to_proxy(proxy, source_dims, clip_props);
        let source = if view.is_identity() {
            None
        } else {
            Some(crop_view(&proxy, view))
        };
        let mut surface = crate::studio::srgb_proxy_surface(source.as_ref().unwrap_or(&proxy))?;
        let grade_started = Instant::now();
        let backend = crate::studio::apply_grade_doc(&doc, &mut surface);
        let grade_ms = grade_started.elapsed().as_secs_f64() * 1000.0;
        if let Some(overlay) = mask_overlay {
            // The overlay tints the *presented* frame: grade first, then
            // composite, so the tint colour is not pushed through the kernel.
            composite_mask_overlay(&mut surface, overlay, proxy.dimensions(), view);
        }
        if let Some(scene) = overlay_scene {
            // Stroked last: the outline sits above the frame and the tint.
            composite_overlay_scene(&mut surface, scene, proxy.dimensions(), view);
        }
        let image = crate::studio::surface_to_rgba(&surface)?;
        return Ok(RenderedRgba {
            image: Arc::new(image),
            backend: grade_backend_report(backend)
                .with_clip_props(props_backend)
                .with_stage_timings(decode_ms, Some(grade_ms)),
            view,
        });
    }
    // Plain path: the viewport's cached source proxy at the bounded size (so
    // a huge surface cannot request a full decode through this path).
    let key = ProxyKey {
        path: path.to_string(),
        time_bits: None,
        size,
    };
    let decode_started = Instant::now();
    let proxy = cached_proxy(id, key, || {
        load_image_srgb_proxy(std::path::Path::new(path), size)
    })?;
    let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
    Ok(RenderedRgba {
        image: proxy,
        backend: cpu_backend().with_stage_timings(decode_ms, None),
        view,
    })
}
