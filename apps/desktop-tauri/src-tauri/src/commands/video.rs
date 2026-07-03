//! Video card commands: probe a dropped clip for a poster + metadata, and
//! scrub to a timestamp for the manual clip editor. Both decode through the
//! shared [`crate::studio::video_engine`] `FrameSource` seam (the native
//! ffmpeg decoder under `native-ffmpeg`).
//!
//! These are the desktop bridge surface only — the decode/cache logic lives in
//! `studio::video_engine`; this module just picks the poster cache location
//! and shapes the TS-facing result.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Metadata + poster-frame path for a dropped video, surfaced on the generic
/// video card. Fields are `snake_case` to match the TS `VideoProbeResult`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct VideoProbeResult {
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// Clip length in seconds; `None` when the container reports none.
    pub(crate) duration_sec: Option<f64>,
    /// Frame rate; `None` when unknown rather than guessed.
    pub(crate) fps: Option<f64>,
    pub(crate) codec: Option<String>,
    /// On-disk PNG of the poster frame (rendered via the image thumbnail path).
    pub(crate) poster_path: String,
}

/// Probe a dropped video and extract a poster frame for the video card.
///
/// Decodes through the media engine's frame source (native libav) to read the
/// metadata and render one frame to a cached PNG. The card then renders that
/// PNG through the existing `generate_thumbnail` pipeline, and the original
/// `path` stays the source of truth for the workflow. The poster is cached
/// under the project output dir keyed by `path + timestamp`.
#[tauri::command]
pub(crate) fn video_probe(
    path: String,
    timestamp: Option<f64>,
    dir: Option<String>,
) -> Result<VideoProbeResult, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    let video = Path::new(trimmed);
    if !video.is_file() {
        return Err(format!("file does not exist: {trimmed}"));
    }
    let _ = dir;

    let ts = timestamp.unwrap_or(0.0).max(0.0);
    let poster_path = poster_cache_path(trimmed, ts)?;

    let mut source = crate::studio::video_engine::make_frame_source();
    let meta = source.probe(video)?;
    source.decode_frame(video, ts, &poster_path)?;
    Ok(VideoProbeResult {
        width: meta.width,
        height: meta.height,
        duration_sec: meta.duration_sec,
        fps: meta.fps,
        codec: meta.codec,
        poster_path: poster_path.to_string_lossy().to_string(),
    })
}

/// The cached poster PNG path for a `(video, timestamp)` pair, under the project
/// output dir's `.posters` cache (created on demand). Keyed by `path + ts` so
/// re-probing the same frame reuses the file.
fn poster_cache_path(video_path: &str, ts: f64) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let poster_dir = crate::cache_subdir(".posters")?;
    let key = format!("{video_path}|{}", (ts * 1000.0).round() as i64);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hasher);
    Ok(poster_dir.join(format!("{:016x}.png", hasher.finish())))
}

/// Scrub to `timestamp` in a video and return the decoded frame's poster path,
/// reusing the media engine's dedicated decode thread + warm frame cache
/// ([`crate::studio::video_engine`]) so repeated seeks over the same
/// neighbourhood are cache hits rather than re-decodes. This backs the manual
/// clip editor's timeline scrubbing (Media lane, step 5).
#[tauri::command]
pub(crate) fn video_scrub(
    path: String,
    timestamp: f64,
    dir: Option<String>,
) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    let video = Path::new(trimmed);
    if !video.is_file() {
        return Err(format!("file does not exist: {trimmed}"));
    }
    let _ = dir;
    let ts = timestamp.max(0.0);
    let poster_dir = crate::cache_subdir(".posters")?;

    crate::studio::video_engine::scrub_frame(&poster_dir, video, ts)
        .map(|frame| frame.to_string_lossy().to_string())
}
