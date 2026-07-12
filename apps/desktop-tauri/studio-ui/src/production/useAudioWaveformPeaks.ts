// Sample-waveform peak lookup for the audio edit modal: decode the source's
// audio stream once per media path through the backend `audio_waveform_peaks`
// command and cache the result for the component's lifetime. Outside Tauri or
// when the file has no decodable audio this resolves to null and the modal
// keeps its schematic envelope.

import { useEffect, useRef, useState } from "react";

import { audioWaveformPeaks, type AudioWaveformPeaksResult } from "../bridge/files";
import { AUDIO_WAVEFORM_PEAK_BUCKET_COUNT } from "./audioWaveformDisplay";

export function useAudioWaveformPeaks(path: string | null): AudioWaveformPeaksResult | null {
  const [result, setResult] = useState<AudioWaveformPeaksResult | null>(null);
  const cache = useRef(new Map<string, AudioWaveformPeaksResult | null>());
  useEffect(() => {
    if (!path) {
      setResult(null);
      return;
    }
    const cached = cache.current.get(path);
    if (cached !== undefined) {
      setResult(cached);
      return;
    }
    let cancelled = false;
    setResult(null);
    audioWaveformPeaks(path, AUDIO_WAVEFORM_PEAK_BUCKET_COUNT).then((peaks) => {
      const value = peaks && peaks.peaks.length > 0 ? peaks : null;
      cache.current.set(path, value);
      if (!cancelled) setResult(value);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return result;
}
