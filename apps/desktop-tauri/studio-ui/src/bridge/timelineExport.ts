// Bridge for the drawer's timeline export command: send the expanded frame
// sequence (one image path per output frame) to the backend `timeline_export`
// command, which encodes it through the same FFmpeg seam as the
// `videoAssemble` node executor.

import { tauriInvoke } from "./core";

// Fields are snake_case to match the Rust `TimelineExportResult` serialization.
export interface TimelineExportResult {
  video_path: string;
  frame_count: number;
  duration_sec: number;
  /** Frames graded before the encode (0 when no clip carried a doc). */
  graded_frame_count: number;
  /** Backend that ran the grade kernel (`cpu` / `gpu`), when frames were graded. */
  grade_backend?: "cpu" | "gpu";
}

/**
 * Encode `frames` at `fps` into a video under the project output dir. Returns
 * `null` outside Tauri (browser preview has no encoder).
 */
export async function timelineExport(
  frames: string[],
  fps: number,
  opts: { codec?: string; outputName?: string; gradeDocs?: (string | null)[] } = {},
): Promise<TimelineExportResult | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return (await invoke("timeline_export", {
    frames,
    fps,
    codec: opts.codec ?? null,
    outputName: opts.outputName ?? null,
    gradeDocs: opts.gradeDocs ?? null,
  })) as TimelineExportResult;
}
