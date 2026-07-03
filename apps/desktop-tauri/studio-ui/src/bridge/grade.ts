// Grading dialog preview bridge: `grade_preview` runs the hgripe-grade kernel
// (GPU when the backend is built with `grade-gpu` and an adapter initialises,
// else the CPU reference path) over a downscaled sRGB proxy of `path` and
// returns the graded frame as a PNG data URL. Outside Tauri it returns `null`
// and the dialog falls back to the in-webview TS mirror.

import { tauriInvoke } from "./core";
import type { GradeDoc } from "../editor/gradeKernel";

export interface GradePreviewResult {
  data_url: string;
  width: number;
  height: number;
  /** Which kernel backend produced the frame: "gpu" | "cpu". */
  backend: string;
  elapsed_ms: number;
}

export async function gradePreview(
  path: string,
  doc: GradeDoc,
  maxDim = 1280,
): Promise<GradePreviewResult | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return (await invoke("grade_preview", {
    path,
    doc,
    maxDim,
  })) as GradePreviewResult;
}
