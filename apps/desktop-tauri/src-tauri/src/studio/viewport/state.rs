use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::studio::{
    ClipPropsBackend, ClipPropsEvaluator, RetainedImageScene, SelectedLayerFrame,
    SelectedLayerMoveDraft,
};

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

impl ViewportTarget {
    /// Snapshot only render-relevant target fields. Image-composite pixels and
    /// node properties live in the retained scene, so a drag render must not
    /// clone the full document JSON on every pointer packet.
    pub(super) fn render_snapshot(&self) -> Self {
        match self {
            Self::ImageComposite {
                resource_id,
                document_key,
                document_width,
                document_height,
                frame_x,
                frame_y,
                frame_width,
                frame_height,
                ..
            } => Self::ImageComposite {
                resource_id: resource_id.clone(),
                document: Value::Null,
                document_key: document_key.clone(),
                document_width: *document_width,
                document_height: *document_height,
                frame_x: *frame_x,
                frame_y: *frame_y,
                frame_width: *frame_width,
                frame_height: *frame_height,
            },
            other => other.clone(),
        }
    }
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
    #[serde(flatten)]
    pub(super) image_layer: ViewportImageLayerFrameMetadata,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewportImageLayerPresentation {
    pub(super) selected_layer_id: String,
    pub(super) transaction_id: String,
    pub(super) base_document_key: String,
    pub(super) sequence: u64,
    pub(super) move_draft: Option<SelectedLayerMoveDraft>,
    #[serde(skip)]
    pub(super) affected_layer_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewportImageScene {
    pub(super) document: Value,
    pub(super) document_key: String,
    pub(super) document_width: u32,
    pub(super) document_height: u32,
    pub(super) frame_x: f32,
    pub(super) frame_y: f32,
    pub(super) frame_width: u32,
    pub(super) frame_height: u32,
}

impl ViewportImageScene {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.document_key.trim().is_empty() {
            return Err("image scene documentKey must not be empty".to_string());
        }
        if self.document_width == 0 || self.document_height == 0 {
            return Err("image scene document dimensions must be positive".to_string());
        }
        if self.frame_width == 0 || self.frame_height == 0 {
            return Err("image scene frame dimensions must be positive".to_string());
        }
        if !self.frame_x.is_finite() || !self.frame_y.is_finite() {
            return Err("image scene frame origin must be finite".to_string());
        }
        Ok(())
    }
}

impl ViewportImageLayerPresentation {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.selected_layer_id.trim().is_empty() {
            return Err("selectedLayerId must not be empty".to_string());
        }
        if self.transaction_id.trim().is_empty() {
            return Err("transactionId must not be empty".to_string());
        }
        if self.base_document_key.trim().is_empty() {
            return Err("baseDocumentKey must not be empty".to_string());
        }
        if self.move_draft.is_some_and(|draft| !draft.is_finite()) {
            return Err("moveDraft coordinates must be finite".to_string());
        }
        Ok(())
    }

    pub(super) fn is_transaction_start(&self) -> bool {
        self.sequence == 0 && self.move_draft.is_none()
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ViewportImageLayerFrameMetadata {
    pub(super) selected_layer_frame: Option<SelectedLayerFrame>,
    pub(super) document_key: Option<String>,
    pub(super) transaction_id: Option<String>,
    pub(super) sequence: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct ViewportGenerations {
    pub(super) content: u64,
    pub(super) render: u64,
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
    /// Ordered compact layer resources for one fully prepared image-document
    /// revision. Target and scene are committed under the same registry lock.
    pub(super) retained_image_scene: Option<Arc<RetainedImageScene>>,
    /// The selected node and its in-memory drag transform. It never changes
    /// target/content identity; a preview advances only render generation.
    pub(super) image_layer_presentation: Option<ViewportImageLayerPresentation>,
    /// Recently replaced transaction ids for the current document revision.
    /// A delayed sequence-zero packet cannot revive one of them.
    pub(super) retired_image_layer_transactions: Vec<String>,
    /// Latest target request reservation. A slower scene build may commit only
    /// if no later target request has superseded it.
    pub(super) target_request_epoch: u64,
    /// Backing-surface identity (target + render size). A change invalidates
    /// the native texture immediately. Grade, clip, mask, scene and camera
    /// parameters do not change this generation: `present_view` may transform
    /// the previous complete presentation until their next settled render,
    /// but can never reuse pixels from another target or size.
    pub(super) content_generation: u64,
    /// Every mutation that can change a settled render increments this value.
    /// A worker may publish only the exact generation it snapshotted.
    pub(super) render_generation: u64,
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

impl ViewportState {
    pub(super) fn generations(&self) -> ViewportGenerations {
        ViewportGenerations {
            content: self.content_generation,
            render: self.render_generation,
        }
    }

    pub(super) fn bump_render_generation(&mut self) {
        self.render_generation = self.render_generation.wrapping_add(1);
    }

    pub(super) fn bump_content_generation(&mut self) {
        self.content_generation = self.content_generation.wrapping_add(1);
        self.bump_render_generation();
    }
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
