import { getOutputDir } from "../../bridge/tauri";
import { batchItems } from "./graph";
import type { ExecutorRegistry } from "../dag";

export const VIDEO_EXECUTORS = {
  // Encodes an ordered frame sequence into a video via the media engine's
  // FFmpeg backend (PyAV worker `assemble`). The encode only exists in the
  // desktop build's Rust runner; this browser-preview executor validates the
  // wiring and returns a plausible mock so the editor stays runnable in dev.
  videoAssemble: async (ctx) => {
    const wired = ctx.inputs.frames;
    const frames = Array.isArray(wired)
      ? wired.map((f) => String(f ?? "").trim()).filter((f) => f.length > 0)
      : batchItems(typeof wired === "string" && wired.trim() ? wired : ctx.params.frames);
    if (frames.length === 0) {
      throw new Error("Video Assemble needs at least one frame (connect frames or set the frames param)");
    }
    const fps = Math.max(1, Number(ctx.params.fps ?? 24) || 24);
    const codec = String(ctx.params.codec ?? "libx264").trim() || "libx264";
    const outputDir =
      String(ctx.params.output_dir ?? "").trim() || (await getOutputDir()) || "/mock/outputs";
    const name = String(ctx.params.output_name ?? "").trim() || `assembled-${Date.now()}`;
    const video = `${outputDir.replace(/\/$/, "")}/${name.includes(".") ? name : `${name}.mp4`}`;
    return {
      video,
      frame_count: frames.length,
      duration_sec: frames.length / fps,
      assemble_report: { fps, codec, frame_count: frames.length, mock: true },
    };
  },
  // Cuts a time range out of a video via the media engine's FFmpeg backend
  // (PyAV worker `trim`). The re-encode only exists in the desktop build's
  // Rust runner; this browser-preview executor validates the wiring and
  // returns a plausible mock so the editor stays runnable in dev.
  videoTrim: async (ctx) => {
    const wired = ctx.inputs.video;
    const video =
      (typeof wired === "string" && wired.trim()) || String(ctx.params.video ?? "").trim();
    if (!video) {
      throw new Error("Video Trim needs a video (connect a video input or set the video param)");
    }
    const startSec = Math.max(0, Number(ctx.params.start_sec ?? 0) || 0);
    const endRaw = Number(ctx.params.end_sec ?? 0) || 0;
    const endSec = endRaw > 0 ? endRaw : null;
    if (endSec !== null && endSec <= startSec) {
      throw new Error("end_sec must be greater than start_sec");
    }
    const codec = String(ctx.params.codec ?? "libx264").trim() || "libx264";
    const outputDir =
      String(ctx.params.output_dir ?? "").trim() || (await getOutputDir()) || "/mock/outputs";
    const name = String(ctx.params.output_name ?? "").trim() || `trimmed-${Date.now()}`;
    const out = `${outputDir.replace(/\/$/, "")}/${name.includes(".") ? name : `${name}.mp4`}`;
    const fps = 24;
    const durationSec = endSec !== null ? endSec - startSec : 1;
    return {
      video: out,
      frame_count: Math.max(1, Math.round(durationSec * fps)),
      duration_sec: durationSec,
      trim_report: { fps, codec, start_sec: startSec, end_sec: endSec, mock: true },
    };
  },
} satisfies ExecutorRegistry;
