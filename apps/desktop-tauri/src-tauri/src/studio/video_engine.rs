//! Media engine: the decoder seam + frame cache + playback/seek thread for the
//! clip editor (`Media` lane, step 5 of `docs/cards/editor-resource-model.md`).
//!
//! This is the Rust foundation the manual video editor will sit on. Three
//! pieces, each independent of the GPU `Semaphore(1)` compute queue so a scrub
//! never stalls on an inference job (and vice-versa):
//!
//! * [`FrameSource`] — the **decoder seam**. Any backend that can probe a clip
//!   and render a frame at a timestamp fits behind it. The impl is the
//!   in-process libav decoder ([`super::ffmpeg_native`]); builds without the
//!   `native-ffmpeg` feature surface an error from every call.
//! * [`super::frame_cache::FrameCache`] — a small LRU of recently decoded frame
//!   PNGs, so scrubbing back over a timestamp is a cache hit, not a re-decode.
//! * [`PlaybackEngine`] — a **dedicated decode thread** fed by a channel. Seek
//!   requests are *latest-wins*: while the thread is busy decoding, queued older
//!   positions are superseded by the newest (the playhead has moved on), so the
//!   preview keeps up with a fast drag instead of grinding through every stale
//!   position.
//!
//! The engine only produces frame *paths* (PNGs the video card already renders
//! through the thumbnail pipeline); it does not itself paint, so it stays off
//! the UI thread entirely. Any decoder failure surfaces as `Err` to the caller.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Deserialize;

use super::frame_cache::{frame_key, FrameCache};

/// How many decoded frames the playback thread keeps warm. Sized for scrubbing
/// a short neighbourhood of the playhead back and forth without re-decoding.
const SCRUB_CACHE_FRAMES: usize = 24;

/// Upper bound on waiting for one scrubbed frame. A single decode is bounded
/// (seek + at most `MAX_FRAMES_TO_TARGET` frames), so a longer silence means
/// the worker is wedged — the caller gets a structured timeout instead of
/// blocking a command thread forever.
const SCRUB_TIMEOUT: Duration = Duration::from_secs(30);

/// Metadata about a probed clip.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct VideoMeta {
    #[serde(default)]
    pub(crate) width: u32,
    #[serde(default)]
    pub(crate) height: u32,
    #[serde(default)]
    pub(crate) duration_sec: Option<f64>,
    #[serde(default)]
    pub(crate) fps: Option<f64>,
    #[serde(default)]
    pub(crate) codec: Option<String>,
}

/// A decoder backend: probe a clip, render one frame at a timestamp to a PNG.
///
/// This is the pluggable seam of the media engine. `Send` so a boxed source can
/// live on the playback thread; not `Sync` because a decoder holds mutable
/// per-file state (the open container) and is only touched from that one thread.
pub(crate) trait FrameSource: Send {
    /// Read a clip's metadata (resolution, duration, fps, codec).
    fn probe(&mut self, video: &Path) -> Result<VideoMeta, String>;
    /// Decode the frame nearest `timestamp_sec`, writing it to `poster_out`.
    /// Returns the on-disk path actually written (normally `poster_out`).
    fn decode_frame(
        &mut self,
        video: &Path,
        timestamp_sec: f64,
        poster_out: &Path,
    ) -> Result<PathBuf, String>;
}

/// [`FrameSource`] for builds without the vendored libav decoder: every call
/// errors, pointing at the `native-ffmpeg` build.
#[cfg(not(feature = "native-ffmpeg"))]
struct UnavailableFrameSource;

#[cfg(not(feature = "native-ffmpeg"))]
impl FrameSource for UnavailableFrameSource {
    fn probe(&mut self, _video: &Path) -> Result<VideoMeta, String> {
        Err(
            "video decoding requires the `native-ffmpeg` build (vendored libav decoders)"
                .to_string(),
        )
    }

    fn decode_frame(
        &mut self,
        _video: &Path,
        _timestamp_sec: f64,
        _poster_out: &Path,
    ) -> Result<PathBuf, String> {
        Err(
            "video decoding requires the `native-ffmpeg` build (vendored libav decoders)"
                .to_string(),
        )
    }
}

/// Probe the video decode backend for the capability summary:
/// `Ok(detail)` when the vendored libav decoder is compiled in
/// (`native-ffmpeg`), `Err(reason)` otherwise. Software-only today; hardware
/// decode/encode joins behind its own probe (GPU_DEVICE_STRATEGY_PLAN).
pub(crate) fn ffmpeg_capability() -> Result<String, String> {
    #[cfg(feature = "native-ffmpeg")]
    {
        Ok("vendored libav (software decode)".to_string())
    }
    #[cfg(not(feature = "native-ffmpeg"))]
    {
        Err("native-ffmpeg feature disabled (no vendored libav decoder)".to_string())
    }
}

/// Probe the FFmpeg *hardware encoder* capability for the capability summary
/// (GPU_DEVICE_STRATEGY_PLAN step 12: hardware FFmpeg joins only behind an
/// explicit probe/report/fallback — this is the probe/report half; nothing
/// selects a hardware encoder yet). `Ok(names)` when the vendored libav has
/// hardware encoders compiled in, `Err(reason)` otherwise. Compiled-in is not
/// a session guarantee: the driver can still refuse at run time, so per-run
/// DeviceReports stay the source of truth.
pub(crate) fn ffmpeg_hw_capability() -> Result<String, String> {
    #[cfg(feature = "native-ffmpeg")]
    {
        let encoders = super::ffmpeg_native::hardware_encoders();
        if encoders.is_empty() {
            Err("no hardware encoders in the vendored libav (software x264 only)".to_string())
        } else {
            Ok(encoders.join(", "))
        }
    }
    #[cfg(not(feature = "native-ffmpeg"))]
    {
        Err("native-ffmpeg feature disabled (no vendored libav)".to_string())
    }
}

/// Probe the FFmpeg *hardware decoder* capability for the capability summary
/// (GPU_DEVICE_STRATEGY_PLAN step 12: hardware FFmpeg is per-operation and
/// joins only behind an explicit probe/report/fallback — an explicit
/// `device: gpu` trim tries a matching hardware decoder through
/// [`decode_with_device`]; playback scrubbing stays on the software
/// baseline). `Ok(names)` when the vendored libav has
/// hardware decoders compiled in, `Err(reason)` otherwise. Compiled-in is not
/// a session guarantee: the driver can still refuse at run time.
pub(crate) fn ffmpeg_hw_decode_capability() -> Result<String, String> {
    #[cfg(feature = "native-ffmpeg")]
    {
        let decoders = super::ffmpeg_native::hardware_decoders();
        if decoders.is_empty() {
            Err("no hardware decoders in the vendored libav (software decode only)".to_string())
        } else {
            Ok(decoders.join(", "))
        }
    }
    #[cfg(not(feature = "native-ffmpeg"))]
    {
        Err("native-ffmpeg feature disabled (no vendored libav)".to_string())
    }
}

/// The compiled-in hardware decoder matching an input codec name (e.g.
/// `h264` -> `h264_cuvid`), from a probed decoder list. Pure name matching,
/// kept separate from the ffi probe so it is testable.
#[cfg_attr(not(feature = "native-ffmpeg"), allow(dead_code))]
pub(crate) fn decoder_for_codec(codec: &str, decoders: &[String]) -> Option<String> {
    let prefix = format!("{codec}_");
    decoders
        .iter()
        .find(|name| name.starts_with(&prefix))
        .cloned()
}

/// The compiled-in hardware decoder for `video`'s codec, or the reason there
/// is none (probe the input codec, then match a `{codec}_*` hardware
/// decoder).
#[cfg(feature = "native-ffmpeg")]
pub(crate) fn hardware_decoder_for_input(video: &std::path::Path) -> Result<String, String> {
    let codec = super::ffmpeg_native::probe_input_codec(video)?;
    decoder_for_codec(&codec, &super::ffmpeg_native::hardware_decoders()).ok_or_else(|| {
        format!("no hardware decoder for '{codec}' compiled into the vendored libav")
    })
}

/// Run a decode-and-re-encode with the shared opt-in hardware *decode*
/// selection/fallback (GPU_DEVICE_STRATEGY_PLAN step 12, per-operation): only
/// an explicit `device: gpu` request tries the compiled-in hardware decoder
/// matching the input codec; any failure retries with the software decoder
/// and keeps the reason visible. `auto` stays on the software baseline (with
/// the standing "not enabled" reason); an honored `cpu` request is not a
/// fallback. Returns `(output, decode_used, decode_reason)` for the caller's
/// `*_report` telemetry (the encode half reports separately through
/// [`encode_with_device`]).
#[cfg(feature = "native-ffmpeg")]
pub(crate) fn decode_with_device<T>(
    device: &str,
    video: &std::path::Path,
    run: impl Fn(Option<&str>) -> Result<T, String>,
) -> Result<(T, super::device_report::DeviceUsed, Option<String>), String> {
    use super::device_report::DeviceUsed;
    let mut fallback_reason = match device {
        "cpu" => None,
        _ => Some("hardware decode not enabled (vendored libav software baseline)".to_string()),
    };
    if device == "gpu" {
        match hardware_decoder_for_input(video) {
            Err(reason) => fallback_reason = Some(reason),
            Ok(hw) => match run(Some(&hw)) {
                Ok(out) => return Ok((out, DeviceUsed::FfmpegHw, None)),
                Err(err) => {
                    fallback_reason = Some(format!("hardware decoder '{hw}' failed: {err}"));
                }
            },
        }
    }
    let out = run(None)?;
    Ok((out, DeviceUsed::FfmpegSw, fallback_reason))
}

/// Run an encode with the shared opt-in hardware selection/fallback
/// (GPU_DEVICE_STRATEGY_PLAN step 12): only an explicit `device: gpu` request
/// tries the first compiled-in hardware H.264 encoder; any failure falls back
/// to `sw_codec` with the reason kept visible. `auto` stays on the software
/// baseline (with the standing "not enabled" reason); an honored `cpu`
/// request is not a fallback. Returns `(output, used, requested, reason)`
/// for the caller's `*_report` telemetry.
#[cfg(feature = "native-ffmpeg")]
pub(crate) fn encode_with_device<T>(
    device: &str,
    sw_codec: &str,
    encode: impl Fn(&str) -> Result<T, String>,
) -> Result<
    (
        T,
        super::device_report::DeviceUsed,
        super::device_report::DeviceRequest,
        Option<String>,
    ),
    String,
> {
    use super::device_report::{DeviceRequest, DeviceUsed};
    let requested = match device {
        "gpu" => DeviceRequest::Gpu,
        "cpu" => DeviceRequest::Cpu,
        _ => DeviceRequest::Auto,
    };
    let mut fallback_reason = match requested {
        DeviceRequest::Cpu => None,
        _ => Some("hardware encode not enabled (vendored libav software baseline)".to_string()),
    };
    if requested == DeviceRequest::Gpu {
        match super::ffmpeg_native::hardware_h264_encoder() {
            None => {
                fallback_reason =
                    Some("no hardware H.264 encoder compiled into the vendored libav".to_string());
            }
            Some(hw) => match encode(&hw) {
                Ok(out) => return Ok((out, DeviceUsed::FfmpegHw, requested, None)),
                Err(err) => {
                    fallback_reason = Some(format!("hardware encoder '{hw}' failed: {err}"));
                }
            },
        }
    }
    let out = encode(sw_codec)?;
    Ok((out, DeviceUsed::FfmpegSw, requested, fallback_reason))
}

/// Build the decoder backend: the in-process libav decoder
/// ([`super::ffmpeg_native`]) — decode errors surface as `Err` to the caller.
/// Without `native-ffmpeg`, a stub source whose every call errors.
pub(crate) fn make_frame_source() -> Box<dyn FrameSource> {
    #[cfg(feature = "native-ffmpeg")]
    {
        Box::new(super::ffmpeg_native::NativeFfmpegFrameSource::new())
    }
    #[cfg(not(feature = "native-ffmpeg"))]
    {
        Box::new(UnavailableFrameSource)
    }
}

/// Return the frame path for `timestamp_sec`, decoding + caching on a miss.
///
/// The cache key quantises the time to milliseconds, so two seeks to the same
/// position share a slot. On a miss the frame is decoded to `poster_dir` under a
/// key-derived name and inserted; an eviction just drops the map entry (the
/// poster files live in a project cache dir that is cleared wholesale).
pub(crate) fn resolve_frame(
    source: &mut dyn FrameSource,
    cache: &mut FrameCache,
    video: &Path,
    timestamp_sec: f64,
    poster_dir: &Path,
) -> Result<PathBuf, String> {
    let key = frame_key(timestamp_sec);
    if let Some(path) = cache.get(key) {
        return Ok(path.to_path_buf());
    }
    let poster_out = poster_dir.join(format!("scrub_{key}.png"));
    let written = source.decode_frame(video, timestamp_sec, &poster_out)?;
    cache.insert(key, written.clone());
    Ok(written)
}

/// One seek request handed to the playback thread, with a one-shot `reply`.
struct ScrubRequest {
    video: PathBuf,
    timestamp_sec: f64,
    poster_dir: PathBuf,
    reply: Sender<Result<PathBuf, String>>,
}

/// Collapse a burst of queued seeks to the newest (latest-wins).
///
/// While the decode thread was busy, any positions that piled up behind it are
/// stale — the playhead is wherever the *last* request points — so we keep only
/// that one and answer every skipped request with `superseded` so its caller
/// never blocks waiting for a frame that will never be decoded.
fn coalesce_latest(first: ScrubRequest, rx: &Receiver<ScrubRequest>) -> ScrubRequest {
    let mut newest = first;
    while let Ok(next) = rx.try_recv() {
        let stale = std::mem::replace(&mut newest, next);
        let _ = stale
            .reply
            .send(Err("superseded by a newer seek".to_string()));
    }
    newest
}

/// A dedicated decode thread + its warm frame cache.
pub(crate) struct PlaybackEngine {
    tx: Option<Sender<ScrubRequest>>,
    handle: Option<JoinHandle<()>>,
}

impl PlaybackEngine {
    /// Spawn the decode thread around `source`, keeping up to `cache_frames`
    /// decoded frames warm.
    fn spawn(source: Box<dyn FrameSource>, cache_frames: usize) -> Self {
        let (tx, rx) = mpsc::channel::<ScrubRequest>();
        let handle = std::thread::spawn(move || {
            let mut source = source;
            let mut cache = FrameCache::new(cache_frames);
            // Ends when every sender is dropped (engine dropped / respawned).
            while let Ok(req) = rx.recv() {
                let req = coalesce_latest(req, &rx);
                let result = resolve_frame(
                    source.as_mut(),
                    &mut cache,
                    &req.video,
                    req.timestamp_sec,
                    &req.poster_dir,
                );
                let _ = req.reply.send(result);
            }
        });
        Self {
            tx: Some(tx),
            handle: Some(handle),
        }
    }

    /// Queue a seek and block until the decode thread answers. Returns the frame
    /// path, or `Err` if the frame was superseded, the decode failed, the
    /// worker crashed, or the decode did not answer within `SCRUB_TIMEOUT`.
    fn scrub_blocking(
        &self,
        video: PathBuf,
        timestamp_sec: f64,
        poster_dir: PathBuf,
    ) -> Result<PathBuf, String> {
        self.scrub_blocking_with_timeout(video, timestamp_sec, poster_dir, SCRUB_TIMEOUT)
    }

    fn scrub_blocking_with_timeout(
        &self,
        video: PathBuf,
        timestamp_sec: f64,
        poster_dir: PathBuf,
        timeout: Duration,
    ) -> Result<PathBuf, String> {
        let tx = self
            .tx
            .as_ref()
            .ok_or_else(|| "playback engine stopped".to_string())?;
        let (reply, out) = mpsc::channel();
        tx.send(ScrubRequest {
            video,
            timestamp_sec,
            poster_dir,
            reply,
        })
        .map_err(|_| "playback engine stopped".to_string())?;
        out.recv_timeout(timeout).map_err(|e| match e {
            RecvTimeoutError::Timeout => format!(
                "playback engine timed out: no frame within {}s",
                timeout.as_secs()
            ),
            RecvTimeoutError::Disconnected => {
                "playback engine worker crashed: the decode thread exited without replying"
                    .to_string()
            }
        })?
    }

    /// Whether the decode thread has exited while the engine still holds its
    /// sender — the loop only ends when every sender drops, so a finished
    /// thread here means the worker crashed (panicked mid-decode).
    fn worker_crashed(&self) -> bool {
        self.tx.is_some() && self.handle.as_ref().is_some_and(JoinHandle::is_finished)
    }
}

impl Drop for PlaybackEngine {
    fn drop(&mut self) {
        // Dropping the sender ends the thread's recv loop; then join it so we
        // never leak the decode thread when the engine is replaced or the app
        // ends.
        self.tx = None;
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

use std::sync::{Mutex, OnceLock};

/// The single process-global playback engine (its own lane, distinct from the
/// torch worker / GPU compute queue). `None` until the first scrub.
static ENGINE: OnceLock<Mutex<Option<PlaybackEngine>>> = OnceLock::new();

fn engine_cell() -> &'static Mutex<Option<PlaybackEngine>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

/// Scrub to `timestamp_sec` in `video` and return the decoded frame's path,
/// spawning the playback engine on demand and reusing its warm frame cache
/// across calls.
pub(crate) fn scrub_frame(
    poster_dir: &Path,
    video: &Path,
    timestamp_sec: f64,
) -> Result<PathBuf, String> {
    let mut guard = engine_cell()
        .lock()
        .map_err(|_| "playback engine mutex poisoned".to_string())?;
    if guard.as_ref().is_some_and(PlaybackEngine::worker_crashed) {
        eprintln!("[video] playback engine worker crashed — respawning the decode thread");
        *guard = None;
    }
    if guard.is_none() {
        let source = make_frame_source();
        *guard = Some(PlaybackEngine::spawn(source, SCRUB_CACHE_FRAMES));
    }
    guard
        .as_ref()
        .expect("engine present after spawn/match check")
        .scrub_blocking(video.to_path_buf(), timestamp_sec, poster_dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A `FrameSource` that decodes nothing: it records how many decodes it was
    /// asked for and echoes a synthetic path, so cache behaviour is observable
    /// without ffmpeg or the filesystem.
    struct MockSource {
        decodes: Arc<AtomicUsize>,
    }

    impl FrameSource for MockSource {
        fn probe(&mut self, _video: &Path) -> Result<VideoMeta, String> {
            Ok(VideoMeta {
                width: 640,
                height: 480,
                duration_sec: Some(10.0),
                fps: Some(24.0),
                codec: Some("h264".into()),
            })
        }

        fn decode_frame(
            &mut self,
            _video: &Path,
            _timestamp_sec: f64,
            poster_out: &Path,
        ) -> Result<PathBuf, String> {
            self.decodes.fetch_add(1, Ordering::SeqCst);
            Ok(poster_out.to_path_buf())
        }
    }

    #[test]
    fn decoder_for_codec_matches_by_codec_prefix() {
        let decoders = vec!["h264_cuvid".to_string(), "hevc_qsv".to_string()];
        assert_eq!(
            decoder_for_codec("h264", &decoders).as_deref(),
            Some("h264_cuvid")
        );
        assert_eq!(
            decoder_for_codec("hevc", &decoders).as_deref(),
            Some("hevc_qsv")
        );
        // No cross-codec match: av1 input must not pick an h264 decoder.
        assert_eq!(decoder_for_codec("av1", &decoders), None);
    }

    #[test]
    fn resolve_frame_decodes_on_miss_and_hits_cache() {
        let decodes = Arc::new(AtomicUsize::new(0));
        let mut source = MockSource {
            decodes: decodes.clone(),
        };
        let mut cache = FrameCache::new(8);
        let video = Path::new("clip.mp4");
        let dir = Path::new("/posters");

        let a = resolve_frame(&mut source, &mut cache, video, 1.0, dir).unwrap();
        let b = resolve_frame(&mut source, &mut cache, video, 1.0, dir).unwrap();
        assert_eq!(a, b);
        assert_eq!(a, PathBuf::from("/posters/scrub_1000.png"));
        // Second seek to the same time is a cache hit — only one decode.
        assert_eq!(decodes.load(Ordering::SeqCst), 1);

        resolve_frame(&mut source, &mut cache, video, 2.0, dir).unwrap();
        assert_eq!(decodes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn coalesce_latest_supersedes_older_requests() {
        let (tx, rx) = mpsc::channel::<ScrubRequest>();
        let (r1, out1) = mpsc::channel();
        let (r2, out2) = mpsc::channel();
        let (r3, out3) = mpsc::channel();
        let mk = |ts: f64, reply: Sender<Result<PathBuf, String>>| ScrubRequest {
            video: PathBuf::from("clip.mp4"),
            timestamp_sec: ts,
            poster_dir: PathBuf::from("/posters"),
            reply,
        };
        tx.send(mk(2.0, r2)).unwrap();
        tx.send(mk(3.0, r3)).unwrap();

        let first = mk(1.0, r1);
        let newest = coalesce_latest(first, &rx);
        assert_eq!(newest.timestamp_sec, 3.0);
        // The two older ones were answered with a superseded error.
        assert!(out1.recv().unwrap().is_err());
        assert!(out2.recv().unwrap().is_err());
        // The newest was NOT answered by coalesce — the caller decodes it.
        assert!(out3.try_recv().is_err());
    }

    /// A `FrameSource` that panics on decode, standing in for a worker crash
    /// (e.g. an FFI fault inside the decoder).
    struct PanickingSource;

    impl FrameSource for PanickingSource {
        fn probe(&mut self, _video: &Path) -> Result<VideoMeta, String> {
            panic!("decoder fault");
        }

        fn decode_frame(
            &mut self,
            _video: &Path,
            _timestamp_sec: f64,
            _poster_out: &Path,
        ) -> Result<PathBuf, String> {
            panic!("decoder fault");
        }
    }

    /// A `FrameSource` that never answers within the caller's patience,
    /// standing in for a wedged decode.
    struct SlowSource;

    impl FrameSource for SlowSource {
        fn probe(&mut self, _video: &Path) -> Result<VideoMeta, String> {
            unreachable!("probe is not used by the playback engine");
        }

        fn decode_frame(
            &mut self,
            _video: &Path,
            _timestamp_sec: f64,
            poster_out: &Path,
        ) -> Result<PathBuf, String> {
            std::thread::sleep(Duration::from_secs(2));
            Ok(poster_out.to_path_buf())
        }
    }

    #[test]
    fn worker_crash_is_reported_and_detected() {
        let engine = PlaybackEngine::spawn(Box::new(PanickingSource), 8);
        let err = engine
            .scrub_blocking(PathBuf::from("clip.mp4"), 1.0, PathBuf::from("/posters"))
            .unwrap_err();
        assert!(err.contains("worker crashed"), "{err}");
        // The reply channel drops during the unwind, so give the thread a
        // moment to actually finish before asserting it is detected.
        for _ in 0..100 {
            if engine.worker_crashed() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(engine.worker_crashed());

        // A healthy engine does not report a crash.
        let healthy = PlaybackEngine::spawn(
            Box::new(MockSource {
                decodes: Arc::new(AtomicUsize::new(0)),
            }),
            8,
        );
        assert!(!healthy.worker_crashed());
    }

    #[test]
    fn scrub_times_out_with_a_structured_reason() {
        let engine = PlaybackEngine::spawn(Box::new(SlowSource), 8);
        let err = engine
            .scrub_blocking_with_timeout(
                PathBuf::from("clip.mp4"),
                1.0,
                PathBuf::from("/posters"),
                Duration::from_millis(50),
            )
            .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        // The worker is wedged, not crashed.
        assert!(!engine.worker_crashed());
    }

    #[test]
    fn playback_engine_reuses_the_cache_across_scrubs() {
        let decodes = Arc::new(AtomicUsize::new(0));
        let source = Box::new(MockSource {
            decodes: decodes.clone(),
        });
        let engine = PlaybackEngine::spawn(source, 8);
        let video = PathBuf::from("clip.mp4");
        let posters = PathBuf::from("/posters");

        let p1 = engine
            .scrub_blocking(video.clone(), 1.0, posters.clone())
            .unwrap();
        let p2 = engine
            .scrub_blocking(video.clone(), 1.0, posters.clone())
            .unwrap();
        assert_eq!(p1, p2);
        assert_eq!(decodes.load(Ordering::SeqCst), 1);

        engine.scrub_blocking(video, 5.0, posters).unwrap();
        assert_eq!(decodes.load(Ordering::SeqCst), 2);
    }
}
