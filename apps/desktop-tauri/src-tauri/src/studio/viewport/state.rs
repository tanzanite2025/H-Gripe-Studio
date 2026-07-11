use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::studio::{ClipPropsBackend, ClipPropsEvaluator};

use super::{MaskOverlay, OverlayScene, SourceProxy, TemporalChain, ViewportView};

/// Hard cap on simultaneously open viewports. Editors open at most a handful;
/// hitting the cap means a caller is leaking viewports instead of destroying
/// them, so creation fails loudly rather than growing without bound.
pub(super) const MAX_VIEWPORTS: usize = 8;

/// What a viewport is allowed to reference. Targets are lightweight references
/// (ids), never pixels — resolution to actual buffers happens Rust-side.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ViewportTarget {
    Image {
        #[serde(rename = "resourceId")]
        resource_id: String,
    },
    ImageLayer {
        #[serde(rename = "assetId")]
        asset_id: String,
        #[serde(rename = "layerId")]
        layer_id: String,
    },
    ImageComposite {
        #[serde(rename = "resourceId")]
        resource_id: String,
        document: Value,
        #[serde(rename = "documentKey")]
        document_key: String,
        #[serde(rename = "documentWidth")]
        document_width: u32,
        #[serde(rename = "documentHeight")]
        document_height: u32,
        #[serde(rename = "frameX", default)]
        frame_x: f32,
        #[serde(rename = "frameY", default)]
        frame_y: f32,
        #[serde(rename = "frameWidth", default)]
        frame_width: Option<u32>,
        #[serde(rename = "frameHeight", default)]
        frame_height: Option<u32>,
    },
    VideoClip {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        #[serde(rename = "clipId")]
        clip_id: String,
        #[serde(rename = "timeSec")]
        time_sec: f64,
        /// Opt-in decode device (`"gpu"` requests the D3D11VA zero-copy
        /// presentation path; anything else stays on the software baseline).
        #[serde(rename = "decodeDevice", default)]
        decode_device: Option<String>,
    },
    /// One decoded frame of a registered video file, addressed by resource
    /// reference + timestamp. The pre-timeline target for grading a raw video
    /// path; timeline clips address frames through [`Self::VideoClip`].
    VideoFrame {
        #[serde(rename = "resourceId")]
        resource_id: String,
        #[serde(rename = "timeSec")]
        time_sec: f64,
        /// Opt-in decode device (`"gpu"` requests the D3D11VA zero-copy
        /// presentation path; anything else stays on the software baseline).
        #[serde(rename = "decodeDevice", default)]
        decode_device: Option<String>,
    },
    NodeOutput {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(rename = "outputPort")]
        output_port: Option<String>,
    },
}

/// Backend report for the fallback contract: fallback is a reportable runtime
/// decision, not a failure.
#[derive(Clone, Serialize)]
pub(crate) struct ViewportBackend {
    pub requested: String,
    pub actual: String,
    /// Human-readable device detail (adapter name + backend) when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decode_processing_time_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props_backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props_backend_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props_fallback_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub props_processing_time_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grade_processing_time_ms: Option<f64>,
}

impl ViewportBackend {
    pub(super) fn with_clip_props(mut self, backend: Option<ClipPropsBackend>) -> Self {
        if let Some(backend) = backend {
            self.props_backend = Some(backend.name.to_string());
            self.props_backend_detail = backend.detail;
            self.props_fallback_reason = backend.fallback_reason;
            self.props_processing_time_ms = Some(backend.processing_time_ms);
        }
        self
    }

    pub(super) fn with_stage_timings(mut self, decode_ms: f64, grade_ms: Option<f64>) -> Self {
        self.decode_processing_time_ms = Some(decode_ms);
        self.grade_processing_time_ms = grade_ms;
        self
    }

    pub(super) fn inherit_processing(mut self, source: &ViewportBackend) -> Self {
        self.decode_processing_time_ms = source.decode_processing_time_ms;
        self.props_backend.clone_from(&source.props_backend);
        self.props_backend_detail
            .clone_from(&source.props_backend_detail);
        self.props_fallback_reason
            .clone_from(&source.props_fallback_reason);
        self.props_processing_time_ms = source.props_processing_time_ms;
        self.grade_processing_time_ms = source.grade_processing_time_ms;
        self
    }
}

/// The backend report a CPU-rendered, PNG-transported frame carries. When the
/// frame instead presents on the native surface the caller replaces this with
/// [`surface_backend_report`], so the reason here describes only the fallback
/// leg of the transport.
pub(crate) fn cpu_backend() -> ViewportBackend {
    ViewportBackend {
        requested: "auto".to_string(),
        actual: "cpu".to_string(),
        detail: None,
        fallback_reason: Some(
            "png transport (frame not presented on the native surface)".to_string(),
        ),
        decode_processing_time_ms: None,
        props_backend: None,
        props_backend_detail: None,
        props_fallback_reason: None,
        props_processing_time_ms: None,
        grade_processing_time_ms: None,
    }
}

/// The backend report a natively presented frame carries (surface swap Phase
/// S4): the frame is on the shared wgpu device's surface, so the badge says
/// `wgpu` with the adapter name — regardless of which kernel graded the
/// pixels (that detail stays in the render backend's `actual` on the PNG
/// path).
pub(super) fn surface_backend_report(requested: &str) -> ViewportBackend {
    let report = crate::studio::wgpu_device::surface_device_report();
    ViewportBackend {
        requested: requested.to_string(),
        actual: "wgpu".to_string(),
        detail: report.backend,
        fallback_reason: None,
        decode_processing_time_ms: None,
        props_backend: None,
        props_backend_detail: None,
        props_fallback_reason: None,
        props_processing_time_ms: None,
        grade_processing_time_ms: None,
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct ViewportDescriptor {
    pub viewport_id: String,
    pub kind: String,
    pub backend: ViewportBackend,
}

/// One rendered frame, presented by the host as an image for now. Later phases
/// replace this with a texture handle; the surrounding protocol stays.
#[derive(Clone, Serialize)]
pub(crate) struct ViewportFrame {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub backend: ViewportBackend,
}

pub(super) struct ViewportState {
    pub(super) kind: String,
    pub(super) target: Option<ViewportTarget>,
    pub(super) width: u32,
    pub(super) height: u32,
    /// Grade document applied at render time (grade_preview viewports); the
    /// doc is parameters only, pixels are resolved through the target.
    pub(super) grade_doc: Option<Value>,
    /// Mask overlay composited over rendered frames (image_edit viewports):
    /// the image editor's proxy-resolution selection tint, presented by the
    /// host at the view window's detail instead of a document-size canvas.
    pub(super) mask_overlay: Option<Arc<MaskOverlay>>,
    /// Vector overlay stroked over rendered frames (image_edit viewports):
    /// the image editor's marquee marching ants, drawn at the view window's
    /// detail instead of on a document-size canvas.
    pub(super) overlay_scene: Option<Arc<OverlayScene>>,
    pub(super) view: ViewportView,
    /// Most-recently-used first, at most [`PROXY_CACHE_DEPTH`] entries.
    pub(super) proxies: Vec<SourceProxy>,
    /// Temporal denoise amount (`0` disables) applied to graded video
    /// frames after the grade doc, blending against the previous graded
    /// frame ([`TemporalChain`]).
    pub(super) temporal_denoise: f32,
    /// The previous graded frame and its identity, for continuity checks.
    pub(super) temporal: Option<TemporalChain>,
    /// Clip property document applied before the grade (video_preview): the
    /// raw doc string (change detection — the parse runs once per document,
    /// not once per frame) beside its parsed form.
    pub(super) clip_props: Option<(String, ClipPropsEvaluator)>,
    /// Clip-local evaluation time (seconds) for `clip_props`.
    pub(super) clip_props_time: f64,
}

static VIEWPORTS: OnceLock<Mutex<HashMap<u64, ViewportState>>> = OnceLock::new();

/// Persistent D3D11VA decode sessions keyed by viewport (continuous playback
/// pacing on the video zero-copy path): a small forward playhead step decodes
/// sequentially from the session's current position instead of reopening the
/// container and seeking to a keyframe per frame. A session is replaced when
/// the viewport's video changes, evicted when a decode fails (the next
/// request reopens fresh), and dropped with the viewport.
#[cfg(all(windows, feature = "viewport-surface", feature = "native-ffmpeg"))]
static HW_SESSIONS: OnceLock<
    Mutex<HashMap<u64, crate::studio::ffmpeg_native::D3d11PlaybackSession>>,
> = OnceLock::new();

#[cfg(all(windows, feature = "viewport-surface", feature = "native-ffmpeg"))]
pub(super) fn hw_sessions(
) -> &'static Mutex<HashMap<u64, crate::studio::ffmpeg_native::D3d11PlaybackSession>> {
    HW_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(super) static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub(super) fn viewports() -> &'static Mutex<HashMap<u64, ViewportState>> {
    VIEWPORTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn parse_id(viewport_id: &str) -> Result<u64, String> {
    viewport_id
        .strip_prefix("vp-")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("invalid viewport id: {viewport_id}"))
}
