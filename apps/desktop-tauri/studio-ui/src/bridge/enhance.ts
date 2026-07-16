import { tauriInvoke } from "./core";
import { type Bounds } from "../contracts/context";

// --- Image Enhance ----------------------------------------------------------
// Wraps the deterministic native Rust `enhance_image` command.

/** What `enhance_image` did; snake_case to match the bridge JSON. */
export interface EnhanceReport {
  /** `conservative | texture_rebuild | custom`. */
  mode: string;
  scale_factor: number;
  /** `[width, height]` of the input image. */
  source_size?: [number, number];
  /** `[width, height]` of the written image. */
  output_size?: [number, number];
  /** `[width, height]` requested target, or null when a preset scale was used. */
  target_size?: [number, number] | null;
  max_pixels: number;
  /** `true` when the scale was reduced to honour `max_pixels`. */
  clamped: boolean;
  denoise_strength: number;
  texture_strength: number;
  preserve_text_logo: boolean;
  processing_time_ms: number;
}

/** Result of the Image Enhance node (`enhance_image`). */
export interface EnhanceImageResult {
  enhanced_image: string;
  scale_factor: number;
  enhance_report: EnhanceReport;
}

export interface EnhanceImageRequest {
  /** Path to the low-resolution base image. */
  image: string;
  /** Connected PSD placeholder bounds {x,y,width,height}; sets the target size. */
  targetBounds?: Bounds;
  /** `conservative | texture_rebuild | custom`. */
  mode?: string;
  /** Explicit target px (0 = auto from bounds / preset scale). */
  targetWidth?: number;
  targetHeight?: number;
  /** Cap on output pixels; the scale is reduced to fit (0 disables). */
  maxPixels?: number;
  /** Upscale factor used when no target size is given (custom only). */
  scale?: number;
  /** Edge-preserving median denoise blend 0..1 (custom only). */
  denoiseStrength?: number;
  /** Unsharp-mask detail strength 0..1 (custom only). */
  textureStrength?: number;
  /** Cap sharpening so logos / packaging text are not mangled. */
  preserveTextLogo?: boolean;
  /** Directory for the written PNG. */
  outputDir?: string;
  /** Base name for the written PNG. */
  outputName?: string;
}

/**
 * Upscale a subject image for PSD placement via the native backend
 * (`enhance_image`). Outside Tauri this returns a plausible built-in CPU mock
 * so the editor stays runnable in browser development.
 */
export async function enhanceImage(req: EnhanceImageRequest): Promise<EnhanceImageResult> {
  const invoke = tauriInvoke();
  if (!invoke) {
    const dir = (req.outputDir ?? "/mock/outputs").replace(/\/$/, "");
    const stem = req.outputName ?? "subject_enhanced";
    const mode = req.mode ?? "conservative";
    if (!["conservative", "texture_rebuild", "custom"].includes(mode)) {
      throw new Error(`unknown mode ${JSON.stringify(mode)}`);
    }
    const custom = mode === "custom";
    const presetScale: Record<string, number> = {
      conservative: 2.0,
      texture_rebuild: 2.0,
      custom: req.scale ?? 2.0,
    };
    const src: [number, number] = [512, 700];
    // Resolve the target the same way the native card does: explicit px > bounds > scale.
    let targetW = req.targetWidth ?? 0;
    let targetH = req.targetHeight ?? 0;
    if (targetW <= 0 && targetH <= 0 && req.targetBounds) {
      targetW = req.targetBounds.width;
      targetH = req.targetBounds.height;
    }
    const hasTarget = targetW > 0 || targetH > 0;
    let scale = hasTarget
      ? Math.max(targetW > 0 ? targetW / src[0] : 0, targetH > 0 ? targetH / src[1] : 0)
      : presetScale[mode] ?? 2.0;
    const maxPixels = req.maxPixels ?? 48_000_000;
    let clamped = false;
    if (maxPixels > 0 && src[0] * scale * (src[1] * scale) > maxPixels) {
      scale *= Math.sqrt(maxPixels / (src[0] * scale * (src[1] * scale)));
      clamped = true;
    }
    const out: [number, number] = [Math.round(src[0] * scale), Math.round(src[1] * scale)];
    let texture = custom
      ? (req.textureStrength ?? 0.25)
      : ({ conservative: 0.25, texture_rebuild: 0.7 }[mode] ?? 0.25);
    const preserveTextLogo = req.preserveTextLogo ?? true;
    if (preserveTextLogo) texture = Math.min(texture, 0.4);
    const scaleFactor = Math.round((out[0] / src[0]) * 1e4) / 1e4;
    return {
      enhanced_image: `${dir}/${stem}.png`,
      scale_factor: scaleFactor,
      enhance_report: {
        mode,
        scale_factor: scaleFactor,
        source_size: src,
        output_size: out,
        target_size: hasTarget ? [targetW, targetH] : null,
        max_pixels: maxPixels,
        clamped,
        denoise_strength: custom
          ? (req.denoiseStrength ?? 0.3)
          : ({ conservative: 0.3, texture_rebuild: 0.15 }[mode] ?? 0.3),
        texture_strength: texture,
        preserve_text_logo: preserveTextLogo,
        processing_time_ms: 0,
      },
    };
  }
  return (await invoke("enhance_image", {
    image: req.image,
    targetBounds: req.targetBounds ? JSON.stringify(req.targetBounds) : null,
    mode: req.mode ?? null,
    targetWidth: req.targetWidth ?? null,
    targetHeight: req.targetHeight ?? null,
    maxPixels: req.maxPixels ?? null,
    scale: req.scale ?? null,
    denoiseStrength: req.denoiseStrength ?? null,
    textureStrength: req.textureStrength ?? null,
    preserveTextLogo: req.preserveTextLogo ?? null,
    outputDir: req.outputDir ?? null,
    outputName: req.outputName ?? null,
  })) as EnhanceImageResult;
}
