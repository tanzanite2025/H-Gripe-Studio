import { tauriInvoke } from "./core";

// --- SAM 2 point-prompt mask -------------------------------------------------
// Wraps the Rust `sam2_prompt_mask` command: the in-process segmenter stack
// (SAM 2 when a positive point exists and its ONNX weights resolve, else the
// salient / builtin CPU fallback) run directly for the Studio Action layer's
// `mask.subject.point_prompt` compute block. The backend writes a matte PNG;
// the Studio Action layer maps it to a selection-alpha artifact, outside a
// workflow graph run. Outside Tauri (browser dev) it returns a plausible mock
// so the action chain stays testable.

/** What `sam2_prompt_mask` produced; snake_case to match the bridge JSON. */
export interface Sam2PromptMaskBridgeResult {
  /** The written grayscale matte PNG; mapped to `selectionAlphaArtifactRef` above the bridge. */
  mask_path: string;
  /** Segmenter that actually ran (`sam2`, a salient model id, `builtin-cpu`). */
  provider: string;
  /** SAM 2 variant requested (`tiny` unless overridden). */
  variant_requested: string;
  /** The weight file(s) inference ran on; `null` for the builtin fallback. */
  model_path: string | null;
  /** Fraction of selected pixels, 0..=1. */
  coverage: number;
  /** `[x, y, width, height]` of the selected region; `null` when empty. */
  bbox: [number, number, number, number] | null;
  /** `[width, height]` of the segmented image (mask dimensions). */
  image_size: [number, number];
  processing_time_ms: number;
}

export interface Sam2PromptMaskBridgeRequest {
  /** Path to the image to segment. */
  image: string;
  /** Point prompts in image-pixel space; needs ≥1 positive (`label: 1`). */
  points: { x: number; y: number; label: 0 | 1 }[];
  /** SAM 2 variant: `tiny` (default) | `small` | `base_plus` | `large`. */
  variant?: string;
  /** Directory for the written matte PNG; the runtime output dir when unset. */
  outputDir?: string;
  /** Base name for the written matte PNG. */
  outputName?: string;
}

/**
 * Run SAM 2 point-prompt segmentation via the backend (`sam2_prompt_mask`)
 * and get the written selection-alpha artifact. Never touches the image editor document;
 * the calling Studio Action commits the artifact onto its layer-mask target.
 */
export async function sam2PromptMask(
  req: Sam2PromptMaskBridgeRequest,
): Promise<Sam2PromptMaskBridgeResult> {
  const invoke = tauriInvoke();
  if (!invoke) {
    const dir = (req.outputDir ?? "/mock/outputs").replace(/\/$/, "");
    const stem = req.outputName ?? "sam2_prompt_mask";
    return {
      mask_path: `${dir}/${stem}.png`,
      provider: "builtin-cpu",
      variant_requested: req.variant ?? "tiny",
      model_path: null,
      coverage: 0.32,
      bbox: [128, 96, 512, 640],
      image_size: [1024, 1024],
      processing_time_ms: 12,
    };
  }
  return (await invoke("sam2_prompt_mask", {
    image: req.image,
    points: req.points,
    variant: req.variant ?? null,
    outputDir: req.outputDir ?? null,
    outputName: req.outputName ?? null,
  })) as Sam2PromptMaskBridgeResult;
}
