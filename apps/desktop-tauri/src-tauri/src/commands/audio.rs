//! Audio clip commands: decode a media file's audio stream and reduce it to
//! per-bucket waveform peaks for the audio edit modal's sample waveform.
//! The decode reuses the timeline mixdown's canonical PCM surface
//! ([`crate::studio` audio mix], 48 kHz stereo interleaved f32, feature
//! `native-ffmpeg`); this module only shapes the TS-facing result.

use serde::Serialize;

/// Waveform peaks for one media file's audio stream. Fields are `snake_case`
/// to match the TS `AudioWaveformPeaksResult`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct AudioWaveformPeaksResult {
    /// Per-bucket peak amplitude in `0..=1`, evenly spanning the stream.
    pub(crate) peaks: Vec<f32>,
    /// Decoded audio stream length, seconds.
    pub(crate) duration_sec: f64,
}

/// Decode `path`'s best audio stream and return `bucket_count` peak
/// amplitudes evenly spanning it — the audio edit modal draws these behind
/// its gain/fade envelope.
#[cfg(feature = "native-ffmpeg")]
#[tauri::command]
pub(crate) fn audio_waveform_peaks(
    path: String,
    bucket_count: usize,
) -> Result<AudioWaveformPeaksResult, String> {
    use crate::studio::{
        decode_audio_pcm, waveform_peaks_from_interleaved_stereo_pcm, MIX_CHANNELS,
        MIX_SAMPLE_RATE,
    };

    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    let media = std::path::Path::new(trimmed);
    if !media.is_file() {
        return Err(format!("file does not exist: {trimmed}"));
    }
    if bucket_count == 0 {
        return Err("bucket_count must be positive".to_string());
    }
    let pcm = decode_audio_pcm(media)?;
    let frames = pcm.len() / MIX_CHANNELS;
    Ok(AudioWaveformPeaksResult {
        peaks: waveform_peaks_from_interleaved_stereo_pcm(&pcm, bucket_count),
        duration_sec: frames as f64 / f64::from(MIX_SAMPLE_RATE),
    })
}

#[cfg(not(feature = "native-ffmpeg"))]
#[tauri::command]
pub(crate) fn audio_waveform_peaks(
    path: String,
    bucket_count: usize,
) -> Result<AudioWaveformPeaksResult, String> {
    let _ = (path, bucket_count);
    Err("audio decoder unavailable (built without native-ffmpeg)".to_string())
}
