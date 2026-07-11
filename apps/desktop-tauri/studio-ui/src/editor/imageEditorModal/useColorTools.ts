// Colour / sampling tool state: the PS colour wells (foreground / background
// + the open picker), the eyedropper's last sample, the persistent
// colour-sampler pins, and underlay pixel sampling. The mask itself is
// grayscale, so a picked colour maps to paint polarity by luminance — a
// light foreground paints the mask in, a dark one erases.
import { useCallback, useRef, useState } from "react";
import type { ViewportViewState } from "../../viewport/view";
import type { WgpuViewportHost } from "../../viewport/WgpuViewportHost";
import { DEFAULT_TOOL_ID, type PaintTarget } from "../imageEditorTools";
import { hexToRgb } from "./ColorPicker";
import type { ColorSample } from "./stagePainter";

/** What the colour tools read from the shell at call time. The shell
 * re-assigns the ref every render (the sampling inputs come from the
 * viewport hook, which runs after this hook), so the handlers here always
 * see the current render's values without re-binding. */
export interface ColorToolsEnv {
  toolId: string;
  /** The active tool's kind (swap flips a path tool's boolean mode). */
  toolKind: string;
  selectTool: (id: string) => void;
  setToolId: (id: string) => void;
  setPathMode: React.Dispatch<React.SetStateAction<"add" | "subtract" | "intersect">>;
  setPaintTarget: (target: PaintTarget) => void;
  /** Presented frame as an image source (PNG transport), or null. */
  underlay: string | null;
  /** The frame is on the viewport's native surface window. */
  presented: boolean;
  /** The open viewport host, for explicit pixel readback. */
  viewportHost: WgpuViewportHost | null;
  /** The view window the presented frame was rendered for. */
  frameView: ViewportViewState;
  dims: { w: number; h: number };
  sceneFrame?: { x: number; y: number; w: number; h: number };
}

export interface ColorTools {
  fgColor: string;
  bgColor: string;
  /** The open colour-well picker, or null. */
  colorPicker: "fg" | "bg" | null;
  setColorPicker: React.Dispatch<React.SetStateAction<"fg" | "bg" | null>>;
  /** Eyedropper sample: the image colour under the last click, as
   * `#rrggbb`; null until sampled. */
  sampledColor: string | null;
  /** Colour sampler pins (up to four persistent readouts, PS I flyout) — a
   * pure view read, session-local, never recorded on the document. */
  colorSamples: ColorSample[];
  setColorSamples: React.Dispatch<React.SetStateAction<ColorSample[]>>;
  resetColors: () => void;
  swapColors: () => void;
  commitPickedColor: (hex: string) => void;
  /** Arm a one-shot colour pick: the next canvas pointer-down samples the
   * underlay into `cb` instead of drawing. */
  requestColorPick: (cb: (hex: string) => void) => void;
  /** Serve an armed colour pick at `pt`; false when none is armed. */
  consumeColorPick: (pt: [number, number]) => boolean;
  sampleUnderlay: (pt: [number, number], onSample?: (hex: string) => void) => void;
}

export function useColorTools(envRef: React.MutableRefObject<ColorToolsEnv | null>): ColorTools {
  const [fgColor, setFgColor] = useState("#ffffff");
  const [bgColor, setBgColor] = useState("#000000");
  const [colorPicker, setColorPicker] = useState<"fg" | "bg" | null>(null);
  const [sampledColor, setSampledColor] = useState<string | null>(null);
  const [colorSamples, setColorSamples] = useState<ColorSample[]>([]);

  // PS `D` (default colours): back to the default brush / add semantics and
  // the default white-over-black wells.
  const resetColors = () => {
    const env = envRef.current;
    if (!env) return;
    env.selectTool(DEFAULT_TOOL_ID);
    env.setPathMode("add");
    env.setPaintTarget("layer");
    setFgColor("#ffffff");
    setBgColor("#000000");
  };

  // PS `X` (swap colours): swap the wells and flip paint polarity —
  // brush↔eraser, or a path tool's boolean mode.
  const swapColors = () => {
    const env = envRef.current;
    if (!env) return;
    setFgColor(bgColor);
    setBgColor(fgColor);
    if (env.toolId === "brush") env.setToolId("eraser");
    else if (env.toolId === "eraser") env.setToolId("brush");
    else if (env.toolKind === "path") env.setPathMode((m) => (m === "add" ? "subtract" : "add"));
  };

  // A picked well colour: in the grayscale mask the foreground's luminance
  // sets the paint polarity (light paints in, dark erases — PS painting on a
  // mask with white/black).
  const commitPickedColor = (hex: string) => {
    const env = envRef.current;
    if (!env) return;
    if (colorPicker === "bg") setBgColor(hex);
    else {
      setFgColor(hex);
      const rgb = hexToRgb(hex);
      if (rgb) {
        const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
        if (env.toolId === "brush" && lum < 0.5) env.setToolId("eraser");
        else if (env.toolId === "eraser" && lum >= 0.5) env.setToolId("brush");
      }
    }
    setColorPicker(null);
  };

  // One-shot colour pick armed by the replace-color popup: the next canvas
  // pointer-down samples the underlay into this callback instead of drawing.
  const colorPickRequest = useRef<((hex: string) => void) | null>(null);
  const requestColorPick = useCallback((cb: (hex: string) => void) => {
    colorPickRequest.current = cb;
  }, []);

  // Eyedropper: read the underlay pixel at an image-space point by drawing
  // the presented frame — a view window of the image — onto an offscreen
  // canvas at the window's document size. Async (the data URL decodes first);
  // a no-op when there is no underlay or the point is outside the window.
  // A natively presented frame has no data URL: explicit pixel readback
  // (`readPixels`, surface swap Phase S4) answers instead.
  const sampleUnderlay = useCallback(
    (pt: [number, number], onSample?: (hex: string) => void) => {
      const env = envRef.current;
      if (!env) return;
      const { underlay, presented, viewportHost, frameView, dims } = env;
      const frame = env.sceneFrame ?? { x: 0, y: 0, w: dims.w, h: dims.h };
      const winW = Math.max(1, Math.round(frame.w / frameView.zoom));
      const winH = Math.max(1, Math.round(frame.h / frameView.zoom));
      const x = Math.round(pt[0] - frame.x - frameView.panX * frame.w);
      const y = Math.round(pt[1] - frame.y - frameView.panY * frame.h);
      if (x < 0 || y < 0 || x >= winW || y >= winH) return;
      const sample = (r: number, g: number, b: number) => {
        const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        if (onSample) onSample(hex);
        else setSampledColor(hex);
      };
      if (!underlay) {
        if (!presented || !viewportHost || !viewportHost.isOpen) return;
        viewportHost
          .readPixels()
          .then((px) => {
            const fx = Math.min(px.width - 1, Math.floor((x / winW) * px.width));
            const fy = Math.min(px.height - 1, Math.floor((y / winH) * px.height));
            const i = (fy * px.width + fx) * 4;
            sample(px.pixels[i], px.pixels[i + 1], px.pixels[i + 2]);
          })
          .catch(() => {
            /* keep the previous sample */
          });
        return;
      }
      const img = new Image();
      img.onload = () => {
        const off = document.createElement("canvas");
        off.width = winW;
        off.height = winH;
        const ctx = off.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, winW, winH);
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
        sample(r, g, b);
      };
      img.src = underlay;
    },
    [envRef],
  );

  // An armed replace-color eyedropper consumes the next canvas click:
  // sample the underlay into the requesting swatch, nothing else fires.
  const consumeColorPick = useCallback(
    (pt: [number, number]): boolean => {
      const cb = colorPickRequest.current;
      if (!cb) return false;
      colorPickRequest.current = null;
      sampleUnderlay(pt, cb);
      return true;
    },
    [sampleUnderlay],
  );

  return {
    fgColor,
    bgColor,
    colorPicker,
    setColorPicker,
    sampledColor,
    colorSamples,
    setColorSamples,
    resetColors,
    swapColors,
    commitPickedColor,
    requestColorPick,
    consumeColorPick,
    sampleUnderlay,
  };
}
