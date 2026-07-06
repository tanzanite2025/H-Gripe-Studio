// Preview speed vs export fidelity (GPU_DEVICE_STRATEGY_PLAN long-term step
// 5, user controls): the grading dialog previews on a downscaled sRGB proxy;
// this preference picks the proxy size. "speed" keeps the small proxy that
// makes slider drags responsive; "fidelity" widens it for a truer preview at
// the cost of slower renders. Exports never read this — they always run at
// full fidelity — and the latest-wins gate / probe / fallback paths are
// untouched.

export type PreviewQuality = "speed" | "fidelity";

export const PREVIEW_QUALITIES: PreviewQuality[] = ["speed", "fidelity"];

export const PREVIEW_QUALITY_KEY = "hgripe.previewQuality";

/** Proxy long-edge size per quality: the historical 1280 default for speed,
 * a doubled surface for fidelity. */
const PROXY_MAX_DIM: Record<PreviewQuality, number> = {
  speed: 1280,
  fidelity: 2560,
};

function isPreviewQuality(value: unknown): value is PreviewQuality {
  return value === "speed" || value === "fidelity";
}

/** The stored preference; `speed` when unset or unreadable (private mode,
 * corrupt value). */
export function getPreviewQuality(): PreviewQuality {
  try {
    const raw = globalThis.localStorage.getItem(PREVIEW_QUALITY_KEY);
    return isPreviewQuality(raw) ? raw : "speed";
  } catch {
    return "speed";
  }
}

/** Persist the preference. `speed` clears the stored value so the default
 * stays the default. Storage failures are ignored — the preference is a
 * convenience, never required state. */
export function setPreviewQuality(quality: PreviewQuality): void {
  try {
    if (quality === "speed") {
      globalThis.localStorage.removeItem(PREVIEW_QUALITY_KEY);
    } else {
      globalThis.localStorage.setItem(PREVIEW_QUALITY_KEY, quality);
    }
  } catch {
    /* the preference is best-effort */
  }
}

/** The preview proxy's long-edge size under the current preference. */
export function previewProxyMaxDim(): number {
  return PROXY_MAX_DIM[getPreviewQuality()];
}
