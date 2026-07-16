import { tauriInvoke } from "./core";

// --- Mask Edge Refine -------------------------------------------------------
// Wraps the native Rust `refine_mask_edge` command: deterministic morphology,
// guided-filter edge snapping, feather and colour decontamination.

/** What `refine_mask_edge` did; snake_case to match the bridge JSON. */
export interface EdgeReport {
  preset: string;
  /** `explicit` when a mask was connected, else `alpha` (the image's own). */
  source_mask: string;
  erode_px: number;
  dilate_px: number;
  feather_px: number;
  guided_radius: number;
  edge_decontaminate: boolean;
  background_blend_strength: number;
  /** `true` when a background was connected and blended into the edge band. */
  background_applied: boolean;
  /** `true` when a trimap was connected and its unknown band was protected. */
  trimap_applied?: boolean;
  /** Pixels in the protected (unknown) band restored from the source matte. */
  protected_band_px?: number;
  edge_band_px: number;
  coverage_before: number;
  coverage_after: number;
  /** `[width, height]` of the written images. */
  output_size?: [number, number];
}

/** Result of the Mask Edge Refine node (`refine_mask_edge`). */
export interface RefineEdgeResult {
  refined_image: string;
  refined_mask: string;
  edge_report: EdgeReport;
}

export interface RefineMaskEdgeRequest {
  /** Path to the subject image whose matte is refined. */
  image: string;
  /** Explicit matte; defaults to the image's own alpha when omitted. */
  mask?: string;
  /** Target background for edge colour blending. */
  background?: string;
  /** PSD placeholder mask (advisory in Phase 1). */
  placeholderMask?: string;
  /**
   * Matting trimap (FG / unknown / BG levels) from the Subject Mask node. When
   * connected, the unknown band is protected from erode/feather so hair / fur /
   * glass continuous alpha survives the edge clean-up.
   */
  trimap?: string;
  /** `clean | natural | soft | custom`. */
  preset?: string;
  /** Bite N px in / grow N px out (custom preset only). */
  erodePx?: number;
  dilatePx?: number;
  /** Gaussian edge feather radius (custom preset only). */
  featherPx?: number;
  /** Guided-filter radius, 0 disables (custom preset only). */
  guidedRadius?: number;
  /** Pull opaque subject colour into the edge band (custom preset only). */
  edgeDecontaminate?: boolean;
  /** Blend the edge band toward the target background 0..1 (custom only). */
  backgroundBlendStrength?: number;
  /** Directory for the written PNGs. */
  outputDir?: string;
  /** Base name for the written PNGs. */
  outputName?: string;
}

/**
 * Refine a cut-out subject's mask edges for PSD compositing via the native
 * backend (`refine_mask_edge`). Outside Tauri this returns a plausible mock so
 * the editor stays runnable in browser development.
 */
export async function refineMaskEdge(req: RefineMaskEdgeRequest): Promise<RefineEdgeResult> {
  const invoke = tauriInvoke();
  if (!invoke) {
    const dir = (req.outputDir ?? "/mock/outputs").replace(/\/$/, "");
    const stem = req.outputName ?? "subject_refined";
    const preset = req.preset ?? "natural";
    const custom = preset === "custom";
    const background = (req.background ?? "").trim().length > 0;
    const blend = custom ? (req.backgroundBlendStrength ?? 0.4) : 0.4;
    return {
      refined_image: `${dir}/${stem}.png`,
      refined_mask: `${dir}/${stem}_mask.png`,
      edge_report: {
        preset,
        source_mask: (req.mask ?? "").trim().length > 0 ? "explicit" : "alpha",
        erode_px: custom ? (req.erodePx ?? 1) : 1,
        dilate_px: custom ? (req.dilatePx ?? 0) : 0,
        feather_px: custom ? (req.featherPx ?? 4) : 6,
        guided_radius: custom ? (req.guidedRadius ?? 8) : 8,
        edge_decontaminate: custom ? (req.edgeDecontaminate ?? true) : preset !== "soft",
        background_blend_strength: blend,
        background_applied: background && blend > 0,
        trimap_applied: (req.trimap ?? "").trim().length > 0,
        protected_band_px: (req.trimap ?? "").trim().length > 0 ? 2048 : 0,
        edge_band_px: 4096,
        coverage_before: 0.44,
        coverage_after: 0.4,
        output_size: [1024, 1400],
      },
    };
  }
  return (await invoke("refine_mask_edge", {
    image: req.image,
    mask: req.mask ?? null,
    background: req.background ?? null,
    placeholderMask: req.placeholderMask ?? null,
    trimap: req.trimap ?? null,
    preset: req.preset ?? null,
    erodePx: req.erodePx ?? null,
    dilatePx: req.dilatePx ?? null,
    featherPx: req.featherPx ?? null,
    guidedRadius: req.guidedRadius ?? null,
    edgeDecontaminate: req.edgeDecontaminate ?? null,
    backgroundBlendStrength: req.backgroundBlendStrength ?? null,
    outputDir: req.outputDir ?? null,
    outputName: req.outputName ?? null,
  })) as RefineEdgeResult;
}
