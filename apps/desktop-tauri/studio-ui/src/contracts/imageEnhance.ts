/** Product-facing Image Enhance choices. Legacy saved-workflow values stay transportable below. */
export const IMAGE_ENHANCE_ENGINE_OPTIONS = ["cpu", "realesrgan"] as const;
export const IMAGE_ENHANCE_DEVICE_OPTIONS = ["auto", "gpu", "cpu"] as const;
export const IMAGE_ENHANCE_PRECISION_OPTIONS = ["auto", "fp32"] as const;

export type ImageEnhanceEngine = (typeof IMAGE_ENHANCE_ENGINE_OPTIONS)[number];
export type ImageEnhanceDevice = (typeof IMAGE_ENHANCE_DEVICE_OPTIONS)[number];
export type ImageEnhancePrecision = (typeof IMAGE_ENHANCE_PRECISION_OPTIONS)[number];

/** No longer shown, but accepted at the bridge so older saved workflows can fall back honestly. */
export type LegacyImageEnhanceEngine = "ccsr" | "supir";
export type LegacyImageEnhanceDevice = "cuda" | "directml";
export type LegacyImageEnhancePrecision = "fp16";

export type ImageEnhanceEngineRequest = ImageEnhanceEngine | LegacyImageEnhanceEngine;
export type ImageEnhanceDeviceRequest = ImageEnhanceDevice | LegacyImageEnhanceDevice;
export type ImageEnhancePrecisionRequest = ImageEnhancePrecision | LegacyImageEnhancePrecision;
