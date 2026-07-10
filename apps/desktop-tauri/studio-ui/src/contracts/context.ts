/** A rectangle in PSD canvas pixel coordinates. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Background appearance extracted from the template's background layer(s). */
export interface BackgroundContext {
  mean_color: [number, number, number];
  dominant_palette: string[];
  brightness: number;
  contrast: number;
  histogram_path: string | null;
  image_path: string | null;
}

/** Lighting heuristics inferred from the background. */
export interface LightingContext {
  direction: string;
  quality: string;
  color_temperature: number;
  description: string;
}

/** Where the generated subject will be placed inside the template. */
export interface PlaceholderContext {
  layer_name: string;
  bounds: Bounds;
  mask_path: string | null;
  safe_area: Bounds | null;
}

/** Structured visual context shared by production nodes. */
export interface VisualContext {
  background: BackgroundContext;
  lighting: LightingContext;
  placeholder: PlaceholderContext;
  prompt_suffix: string;
}
