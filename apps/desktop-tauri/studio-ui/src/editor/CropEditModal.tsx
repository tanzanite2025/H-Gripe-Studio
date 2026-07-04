import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNodeOutputSource } from "../viewport/useNodeOutputSource";
import { useViewportUnderlay } from "../viewport/useViewportUnderlay";
import { IDENTITY_VIEW, panView, zoomViewAt, type ViewportViewState } from "../viewport/view";
import { useT } from "../i18n";

// Logical fallback size when the connected image has no decodable thumbnail
// (browser preview mocks the backend). The crop box is recorded in this pixel
// space and the backend crops the real image against it on run.
const DEFAULT_W = 960;
const DEFAULT_H = 640;

const ASPECTS = ["free", "1:1", "4:3", "3:2", "16:9", "2:3", "3:4", "9:16"] as const;

/** A crop box in image pixels. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropCommit {
  mode: "manual" | "auto_subject";
  /** `[x, y, w, h]` in image pixels; omitted for auto (computed by the backend). */
  cropBox: [number, number, number, number] | null;
  aspect: string;
  marginPct: number;
}

interface CropEditModalProps {
  title: string;
  imagePath?: string | null;
  /** Node whose output backs the underlay, for a `node_output` target. */
  nodeId?: string | null;
  initialMode: "manual" | "auto_subject";
  initialBox: [number, number, number, number] | null;
  initialAspect: string;
  initialMargin: number;
  onCommit: (commit: CropCommit) => void;
  onClose: () => void;
  /** Optional bar content (e.g. the unified editor's tool-group switcher). */
  headerExtra?: ReactNode;
}

type DragKind = "draw" | "move" | "nw" | "ne" | "sw" | "se";

function aspectRatio(aspect: string): number | null {
  if (aspect === "free") return null;
  const [a, b] = aspect.split(":");
  const an = Number(a);
  const bn = Number(b);
  return an > 0 && bn > 0 ? an / bn : null;
}

function clampBox(box: CropBox, w: number, h: number): CropBox {
  const bw = Math.min(Math.max(1, Math.round(box.w)), w);
  const bh = Math.min(Math.max(1, Math.round(box.h)), h);
  const bx = Math.min(Math.max(0, Math.round(box.x)), w - bw);
  const by = Math.min(Math.max(0, Math.round(box.y)), h - bh);
  return { x: bx, y: by, w: bw, h: bh };
}

/** A centred box covering ~80% of the image, used as the default manual box. */
function defaultBox(w: number, h: number): CropBox {
  const bw = Math.round(w * 0.8);
  const bh = Math.round(h * 0.8);
  return { x: Math.round((w - bw) / 2), y: Math.round((h - bh) / 2), w: bw, h: bh };
}

export function CropEditModal({
  title,
  imagePath,
  nodeId,
  initialMode,
  initialBox,
  initialAspect,
  initialMargin,
  onCommit,
  onClose,
  headerExtra,
}: CropEditModalProps) {
  const t = useT();
  // Zoom/pan is viewport state (WGPU migration Phase 2): the underlay renders
  // the view window over the cached proxy while the crop box stays in image
  // pixels. Wheel zooms, middle-drag or Space+drag pans, double-click resets.
  const [view, setView] = useState<ViewportViewState>(IDENTITY_VIEW);
  const panDrag = useRef<{ x: number; y: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Underlay presentation goes through the viewport host (WGPU migration
  // Phase 2) by reference — a `node_output` target when a node id is given;
  // null in browser preview, where the fallback dims + box stay.
  const source = useNodeOutputSource(nodeId, imagePath);
  const viewport = useViewportUnderlay("image_edit", source, 1280, view);
  const underlay = viewport.underlay;
  const dims = viewport.dims ?? { w: DEFAULT_W, h: DEFAULT_H };
  const [mode, setMode] = useState<"manual" | "auto_subject">(initialMode);
  const [aspect, setAspect] = useState<string>(initialAspect);
  const [margin, setMargin] = useState<number>(initialMargin);
  const [box, setBox] = useState<CropBox>(() =>
    initialBox ? { x: initialBox[0], y: initialBox[1], w: initialBox[2], h: initialBox[3] } : defaultBox(DEFAULT_W, DEFAULT_H),
  );
  // Whether the box came from the user (vs the default seeded for fresh dims).
  const boxTouched = useRef<boolean>(initialBox != null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ kind: DragKind; startX: number; startY: number; origin: CropBox } | null>(null);

  // Re-seed the default box once the true image dimensions arrive, unless the
  // user already placed one.
  useEffect(() => {
    if (viewport.dims && !boxTouched.current) {
      setBox(defaultBox(viewport.dims.w, viewport.dims.h));
    }
  }, [viewport.dims]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === " " && !e.repeat) setSpaceHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [onClose]);

  const ratio = useMemo(() => aspectRatio(aspect), [aspect]);

  // Apply the locked aspect ratio to a box, keeping width and deriving height.
  const applyAspect = useCallback(
    (b: CropBox): CropBox => {
      if (ratio == null) return b;
      return { ...b, h: Math.round(b.w / ratio) };
    },
    [ratio],
  );

  // Map a pointer event to image-pixel coordinates: the stage shows the view
  // window ([panX, panX + 1/zoom] of the frame), so stage-relative positions
  // pass through the view before scaling to pixels.
  const toImage = useCallback(
    (e: React.PointerEvent): [number, number] => {
      const stage = stageRef.current;
      if (!stage) return [0, 0];
      const rect = stage.getBoundingClientRect();
      const x = (view.panX + (e.clientX - rect.left) / rect.width / view.zoom) * dims.w;
      const y = (view.panY + (e.clientY - rect.top) / rect.height / view.zoom) * dims.h;
      return [x, y];
    },
    [dims.w, dims.h, view],
  );

  const handleWheel = (e: React.WheelEvent) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const fx = rect && rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const fy = rect && rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    setView((v) => zoomViewAt(v, e.deltaY < 0 ? 1.25 : 0.8, fx, fy));
  };

  const panning = spaceHeld || panDrag.current != null;

  const onPointerDown = (kind: DragKind) => (e: React.PointerEvent) => {
    // Middle button (or Space held) pans the zoomed view instead of editing
    // the crop box.
    if (e.button === 1 || spaceHeld) {
      if (view.zoom <= 1) return;
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      panDrag.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (mode !== "manual") return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [px, py] = toImage(e);
    boxTouched.current = true;
    if (kind === "draw") {
      const seed: CropBox = { x: Math.round(px), y: Math.round(py), w: 1, h: 1 };
      setBox(seed);
      drag.current = { kind: "se", startX: px, startY: py, origin: seed };
    } else {
      drag.current = { kind, startX: px, startY: py, origin: box };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const pan = panDrag.current;
    if (pan) {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      panDrag.current = { x: e.clientX, y: e.clientY };
      setView((v) => panView(v, dx, dy, rect.width, rect.height));
      return;
    }
    const d = drag.current;
    if (!d || mode !== "manual") return;
    const [px, py] = toImage(e);
    const dx = px - d.startX;
    const dy = py - d.startY;
    const o = d.origin;
    let next: CropBox = o;
    if (d.kind === "move") {
      next = { ...o, x: o.x + dx, y: o.y + dy };
    } else {
      // Resize from a corner: derive the new rect from the fixed opposite corner.
      let left = o.x;
      let top = o.y;
      let right = o.x + o.w;
      let bottom = o.y + o.h;
      if (d.kind === "nw") {
        left = o.x + dx;
        top = o.y + dy;
      } else if (d.kind === "ne") {
        right = o.x + o.w + dx;
        top = o.y + dy;
      } else if (d.kind === "sw") {
        left = o.x + dx;
        bottom = o.y + o.h + dy;
      } else if (d.kind === "se") {
        right = o.x + o.w + dx;
        bottom = o.y + o.h + dy;
      }
      next = {
        x: Math.min(left, right),
        y: Math.min(top, bottom),
        w: Math.abs(right - left),
        h: Math.abs(bottom - top),
      };
      next = applyAspect(next);
    }
    setBox(clampBox(next, dims.w, dims.h));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current || panDrag.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      drag.current = null;
      panDrag.current = null;
    }
  };

  const display = clampBox(box, dims.w, dims.h);
  // Box rect as percentages of the stage, mapped through the view window so
  // it tracks the zoomed/panned underlay (the stage clips overflow).
  const pct = {
    left: `${(display.x / dims.w - view.panX) * view.zoom * 100}%`,
    top: `${(display.y / dims.h - view.panY) * view.zoom * 100}%`,
    width: `${(display.w / dims.w) * view.zoom * 100}%`,
    height: `${(display.h / dims.h) * view.zoom * 100}%`,
  };

  const handleApply = () => {
    if (mode === "auto_subject") {
      onCommit({ mode, cropBox: null, aspect, marginPct: margin });
    } else {
      const b = clampBox(box, dims.w, dims.h);
      onCommit({ mode, cropBox: [b.x, b.y, b.w, b.h], aspect, marginPct: margin });
    }
    onClose();
  };

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className="media-viewer crop-edit" onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          <span className="media-viewer-name" title={title}>
            {title} <span className="muted">· {t("crop.title")}</span>
            {view.zoom > 1 ? <span className="muted"> · {Math.round(view.zoom * 100)}%</span> : null}
          </span>
          {headerExtra}
          <div className="media-viewer-actions">
            <button className="primary" onClick={handleApply} title={t("crop.applyTitle")}>
              {t("crop.apply")}
            </button>
            <button onClick={onClose} title={t("crop.closeTitle")}>
              ✕
            </button>
          </div>
        </div>

        <div className="mask-edit-body">
          <div className="crop-edit-stage-wrap">
            <div
              ref={stageRef}
              className={`crop-edit-stage${mode === "auto_subject" ? " auto" : ""}`}
              style={{
                aspectRatio: `${dims.w} / ${dims.h}`,
                cursor: panning && view.zoom > 1 ? (panDrag.current ? "grabbing" : "grab") : undefined,
              }}
              onWheel={handleWheel}
              onDoubleClick={() => setView(IDENTITY_VIEW)}
              onPointerDown={onPointerDown("draw")}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              {underlay ? (
                <img className="crop-edit-img" src={underlay} alt="preview" draggable={false} />
              ) : (
                <div className="crop-edit-img placeholder" />
              )}
              {mode === "manual" ? (
                <div className="crop-box" style={pct} onPointerDown={onPointerDown("move")}>
                  <span className="crop-handle nw" onPointerDown={onPointerDown("nw")} />
                  <span className="crop-handle ne" onPointerDown={onPointerDown("ne")} />
                  <span className="crop-handle sw" onPointerDown={onPointerDown("sw")} />
                  <span className="crop-handle se" onPointerDown={onPointerDown("se")} />
                </div>
              ) : null}
            </div>
            <small className="muted">
              {mode === "manual" ? t("crop.drawHint") : t("crop.autoHint")}
            </small>
          </div>

          <div className="mask-edit-controls">
            <div className="field">
              <span>{t("crop.title")}</span>
              <div className="crop-mode-row">
                <button
                  className={mode === "manual" ? "active" : ""}
                  title={t("crop.modeManualTitle")}
                  onClick={() => setMode("manual")}
                >
                  {t("crop.modeManual")}
                </button>
                <button
                  className={mode === "auto_subject" ? "active" : ""}
                  title={t("crop.modeAutoTitle")}
                  onClick={() => setMode("auto_subject")}
                >
                  {t("crop.modeAuto")}
                </button>
              </div>
            </div>

            <label className="field">
              <span>{t("crop.aspect")}</span>
              <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                {ASPECTS.map((a) => (
                  <option key={a} value={a}>
                    {a === "free" ? t("crop.aspectFree") : a}
                  </option>
                ))}
              </select>
            </label>

            {mode === "auto_subject" ? (
              <label className="field">
                <span>{t("crop.margin")}</span>
                <span className="slider-row">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={margin}
                    onChange={(e) => setMargin(Number(e.target.value))}
                  />
                  <output>{margin}</output>
                </span>
              </label>
            ) : (
              <>
                <div className="field">
                  <span>{t("crop.boxLabel")}</span>
                  <small className="muted">
                    {display.x},{display.y} · {display.w}×{display.h}
                  </small>
                </div>
                <button onClick={() => setBox(defaultBox(dims.w, dims.h))}>{t("crop.reset")}</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
