// Crop tool state: the adjustable rect between the box drag and the commit
// click, and the floating crop panel's controls
// (pixel W×H draft, aspect presets, ratio lock, saved size templates).
import { useEffect, useRef, useState } from "react";
import type { ImageEditorAction } from "./actions";

/** Preset crop aspect ratios (label -> width/height). */
export const CROP_ASPECTS: [string, number][] = [
  ["1:1", 1],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["3:2", 3 / 2],
  ["2:3", 2 / 3],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
];

/** User-saved crop size templates (width × height in image px). */
const CROP_TEMPLATES_KEY = "hgripe.studio.cropSizeTemplates.v1";

function loadCropTemplates(): { w: number; h: number }[] {
  try {
    const raw = localStorage.getItem(CROP_TEMPLATES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is { w: number; h: number } =>
        typeof x === "object" && x !== null &&
        typeof (x as { w?: unknown }).w === "number" &&
        typeof (x as { h?: unknown }).h === "number",
    );
  } catch {
    return [];
  }
}

export interface CropTool {
  /** Image-workspace crop: the adjustable rect draft ([x0, y0, x1, y1]
   * image-space) between the box drag and the commit click. */
  cropDraft: [number, number, number, number] | null;
  setCropDraft: React.Dispatch<React.SetStateAction<[number, number, number, number] | null>>;
  cropSizeDraft: { w: number; h: number };
  cropAspect: string;
  setCropAspect: (v: string) => void;
  cropLock: boolean;
  setCropLock: (v: boolean) => void;
  cropLockRatio: React.MutableRefObject<number | null>;
  cropTemplates: { w: number; h: number }[];
  confirmCropDraft: (draft: [number, number, number, number]) => void;
  applyCropAspect: (label: string) => void;
  applyCropSize: (w: number, h: number) => void;
  onCropSizeInput: (axis: "w" | "h", value: number) => void;
  saveCropTemplate: () => void;
}

export function useCropTool(
  dims: { w: number; h: number },
  dispatch: (action: ImageEditorAction) => void,
): CropTool {
  const [cropDraft, setCropDraft] = useState<[number, number, number, number] | null>(null);
  // Crop panel state: local W×H draft (re-seeded from the box), the selected
  // aspect preset ("" = free; manual sizing clears it), the ratio lock, and
  // the user's saved size templates.
  const [cropSizeDraft, setCropSizeDraft] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [cropAspect, setCropAspect] = useState("");
  const [cropLock, setCropLock] = useState(false);
  // The ratio the lock holds. Captured when the box changes by any means
  // other than the size inputs (drag, preset, template) — not re-derived
  // from the rounded W×H on every keystroke, which would drift.
  const cropLockRatio = useRef<number | null>(null);
  const cropSizeFromInput = useRef(false);
  const [cropTemplates, setCropTemplates] = useState<{ w: number; h: number }[]>(loadCropTemplates);
  useEffect(() => {
    if (cropDraft) {
      const w = Math.round(Math.abs(cropDraft[2] - cropDraft[0]));
      const h = Math.round(Math.abs(cropDraft[3] - cropDraft[1]));
      setCropSizeDraft({ w, h });
      if (!cropSizeFromInput.current) cropLockRatio.current = w >= 2 && h >= 2 ? w / h : null;
      cropSizeFromInput.current = false;
    }
  }, [cropDraft]);
  const confirmCropDraft = (draft: [number, number, number, number]) => {
    setCropDraft(null);
    dispatch({
      type: "op",
      op: {
        type: "crop",
        region: [
          Math.round(draft[0]),
          Math.round(draft[1]),
          Math.round(draft[2]),
          Math.round(draft[3]),
        ],
      },
    });
  };
  // Resize the box from the panel: anchored at its top-left, clamped to the
  // image (the anchor shifts back in when the size would overflow).
  const resizeCropDraft = (w: number, h: number) => {
    setCropDraft((prev) => {
      if (!prev) return prev;
      const bw = Math.max(2, Math.min(Math.round(w), dims.w));
      const bh = Math.max(2, Math.min(Math.round(h), dims.h));
      const x0 = Math.min(prev[0], dims.w - bw);
      const y0 = Math.min(prev[1], dims.h - bh);
      return [x0, y0, x0 + bw, y0 + bh];
    });
  };
  const cropSizeForRatio = (ratio: number): { w: number; h: number } => {
    const base = cropDraft ?? [0, 0, dims.w, dims.h];
    let w = Math.abs(base[2] - base[0]);
    let h = w / ratio;
    if (h > dims.h) {
      h = dims.h;
      w = h * ratio;
    }
    if (w > dims.w) {
      w = dims.w;
      h = w / ratio;
    }
    return { w: Math.max(2, Math.round(w)), h: Math.max(2, Math.round(h)) };
  };
  const applyCropAspect = (label: string) => {
    setCropAspect(label);
    const preset = CROP_ASPECTS.find(([l]) => l === label);
    if (preset) {
      cropLockRatio.current = preset[1];
      const { w, h } = cropSizeForRatio(preset[1]);
      cropSizeFromInput.current = true;
      resizeCropDraft(w, h);
    }
  };
  const applyCropSize = (w: number, h: number) => {
    setCropSizeDraft({ w, h });
    if (w >= 2 && h >= 2) {
      cropSizeFromInput.current = true;
      resizeCropDraft(w, h);
    }
  };
  const onCropSizeInput = (axis: "w" | "h", value: number) => {
    const other = axis === "w" ? cropSizeDraft.h : cropSizeDraft.w;
    const ratio = cropLockRatio.current;
    if (cropLock && ratio && value >= 2) {
      if (axis === "w") applyCropSize(value, Math.max(2, Math.round(value / ratio)));
      else applyCropSize(Math.max(2, Math.round(value * ratio)), value);
      return;
    }
    // Manual pixel sizing leaves any picked preset behind.
    setCropAspect("");
    if (axis === "w") applyCropSize(value, other);
    else applyCropSize(other, value);
  };
  const saveCropTemplate = () => {
    const { w, h } = cropSizeDraft;
    if (w < 2 || h < 2) return;
    setCropTemplates((prev) => {
      if (prev.some((t2) => t2.w === w && t2.h === h)) return prev;
      const next = [...prev, { w, h }];
      try {
        localStorage.setItem(CROP_TEMPLATES_KEY, JSON.stringify(next));
      } catch {
        // Storage may be unavailable (private mode); templates stay in-memory.
      }
      return next;
    });
  };
  return {
    cropDraft,
    setCropDraft,
    cropSizeDraft,
    cropAspect,
    setCropAspect,
    cropLock,
    setCropLock,
    cropLockRatio,
    cropTemplates,
    confirmCropDraft,
    applyCropAspect,
    applyCropSize,
    onCropSizeInput,
    saveCropTemplate,
  };
}
