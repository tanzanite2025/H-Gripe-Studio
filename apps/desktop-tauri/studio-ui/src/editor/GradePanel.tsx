import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { gradeExportCube } from "../bridge/grade";
import { generateThumbnail, videoProbe } from "../bridge/tauri";
import {
  describeDeviceReport,
  deviceReportFromViewportBackend,
  type DeviceReport,
} from "../runtime/deviceReport";
import { useGradeViewport } from "../viewport/useGradeViewport";
import { useViewControls } from "../viewport/useViewControls";
import { useT, type MsgKey } from "../i18n";
import {
  applyDoc,
  MAX_BLUR_SIGMA,
  MAX_RADIUS,
  parseCube,
  type ColorRange,
  type GradeDoc,
  type GradeOp,
  type RangeAdjust,
  type WarpPoint,
} from "./gradeKernel";

// The embeddable grading surface: an op stack over an image with a live
// preview. Hosted by the GradeEditModal wrapper (node cards) and by the
// production drawer's Grade tab, so every grading context shares the same
// hgripe-grade kernel and UI. The preview prefers the backend `grade_preview`
// command (GPU when built with `grade-gpu`, else its CPU reference path);
// outside Tauri, or when the command fails, it falls back to the in-webview
// TS mirror over the thumbnail underlay.
//
// The panel owns its op-stack state, seeded from `initialDoc`; hosts remount
// it (React `key`) when the grading target changes.

export interface GradeCommit {
  /** The grade document as a JSON string (the node's `grade_doc` param). */
  gradeDoc: string;
}

export interface GradePanelProps {
  imagePath?: string | null;
  /**
   * Grade a video frame instead of an image: the frame nearest
   * `videoTimestampSec` (default 0) is decoded through the native media
   * engine into the same working surface stills use. Takes precedence over
   * `imagePath` when set.
   */
  videoPath?: string | null;
  videoTimestampSec?: number;
  /** When grading a node's output: present it as a `node_output` reference
   * target of this node instead of a plain image resource. */
  nodeId?: string | null;
  /** The target's current grade doc (JSON string), if any. */
  initialDoc?: string | null;
  onCommit: (commit: GradeCommit) => void;
  /** Label for the apply button; defaults to `grade.apply`. */
  applyLabelKey?: MsgKey;
}

/** The op kinds the panel can add, in menu order. */
const ADDABLE_OPS = [
  "exposure",
  "white_balance_k",
  "contrast",
  "saturation",
  "rgb_mixer",
  "color_ranges",
  "color_warper",
  "sharpen",
  "denoise",
  "film_grain",
  "blur",
  "vignette",
] as const;
type AddableOp = (typeof ADDABLE_OPS)[number];

// Panel labels for op kinds. Ops authored elsewhere (e.g. curves from a
// preset) fall back to their serde tag and stay uneditable but preserved.
const OP_LABEL_KEYS: Partial<Record<GradeOp["type"], MsgKey>> = {
  exposure: "grade.op_exposure",
  white_balance: "grade.op_white_balance",
  white_balance_k: "grade.op_white_balance_k",
  contrast: "grade.op_contrast",
  saturation: "grade.op_saturation",
  rgb_mixer: "grade.op_rgb_mixer",
  color_ranges: "grade.op_color_ranges",
  color_warper: "grade.op_color_warper",
  sharpen: "grade.op_sharpen",
  denoise: "grade.op_denoise",
  film_grain: "grade.op_film_grain",
  blur: "grade.op_blur",
  vignette: "grade.op_vignette",
  lut1d: "grade.op_lut1d",
  lut3d: "grade.op_lut3d",
};

// Backend badge labels keyed by the shared DeviceReport `used` vocabulary;
// `mirror` is the in-webview TS fallback (no viewport backend involved).
const BACKEND_LABEL_KEYS: Record<string, MsgKey> = {
  wgpu: "grade.backend_gpu",
  cpu: "grade.backend_cpu",
  mirror: "grade.backend_mirror",
};

function defaultOp(kind: AddableOp): GradeOp {
  switch (kind) {
    case "exposure":
      return { type: "exposure", ev: 0 };
    case "white_balance_k":
      return { type: "white_balance_k", temp_k: 6500, tint: 0 };
    case "contrast":
      return { type: "contrast", amount: 1, pivot: 0.5 };
    case "saturation":
      return { type: "saturation", amount: 0 };
    case "rgb_mixer":
      return { type: "rgb_mixer", red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], monochrome: false };
    case "color_ranges":
      return {
        type: "color_ranges",
        ranges: COLOR_RANGES.map((range) => ({ range, hue: 0, saturation: 0, lightness: 0 })),
        monochrome: false,
      };
    case "color_warper":
      return { type: "color_warper", points: [] };
    case "sharpen":
      return { type: "sharpen", amount: 0, radius: 1 };
    case "denoise":
      return { type: "denoise", amount: 0, radius: 1 };
    case "film_grain":
      return { type: "film_grain", amount: 0, seed: 1 };
    case "blur":
      return { type: "blur", sigma: 0 };
    case "vignette":
      return { type: "vignette", amount: 0, midpoint: 0.5, feather: 0.5 };
  }
}

/** The nine colour ranges of the unified range-adjust op, in menu order. */
const COLOR_RANGES: ColorRange[] = [
  "reds",
  "yellows",
  "greens",
  "cyans",
  "blues",
  "magentas",
  "whites",
  "neutrals",
  "blacks",
];

function defaultWarpPoint(): WarpPoint {
  return { hue: 0, sat: 0.5, hue_shift: 0, sat_scale: 1, hue_radius: 30, sat_radius: 0.25 };
}

/** Parse a grade doc (JSON string) into the first layer's op stack. */
function parseInitialOps(initialDoc?: string | null): GradeOp[] {
  if (!initialDoc || !initialDoc.trim()) return [];
  try {
    const doc = JSON.parse(initialDoc) as GradeDoc;
    return Array.isArray(doc.layers) && doc.layers.length > 0 ? (doc.layers[0].ops ?? []) : [];
  } catch {
    return [];
  }
}

function docFromOps(ops: GradeOp[]): GradeDoc {
  return { layers: [{ blend: "normal", opacity: 1, visible: true, mask: null, ops }] };
}

/** Identity document: grading it renders the ungraded base frame. */
const EMPTY_DOC: GradeDoc = docFromOps([]);

// Run the TS mirror over a data-URL underlay: decode to canvas pixels, grade
// the f32 sRGB surface in place, re-encode. The browser-preview / error path.
async function mirrorPreview(underlay: string, doc: GradeDoc): Promise<string | null> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("underlay decode failed"));
    img.src = underlay;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = new Float32Array(pixels.data.length);
  for (let i = 0; i < pixels.data.length; i++) data[i] = pixels.data[i] / 255;
  applyDoc(doc, { w: canvas.width, h: canvas.height, data, space: "srgb" });
  for (let i = 0; i < pixels.data.length; i++) {
    data[i] = Math.min(Math.max(data[i], 0), 1);
    pixels.data[i] = Math.round(data[i] * 255);
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL("image/png");
}

export function GradePanel({
  imagePath,
  videoPath,
  videoTimestampSec = 0,
  nodeId,
  initialDoc,
  onCommit,
  applyLabelKey,
}: GradePanelProps) {
  const t = useT();
  const [ops, setOps] = useState<GradeOp[]>(() => parseInitialOps(initialDoc));
  const [addKind, setAddKind] = useState<AddableOp>("exposure");
  const [underlay, setUnderlay] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // The graded frame is on the viewport's native surface window (WGPU surface
  // swap): `preview`/`underlay` stay null and the stage lets the surface show
  // through instead of mounting an `<img>`.
  const [presented, setPresented] = useState(false);
  const [backend, setBackend] = useState<DeviceReport | "mirror" | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Preview zoom/pan is viewport state (Phase 3): the host crops its cached
  // source proxy, so wheel/drag ticks re-run only crop + kernel. Identity
  // outside Tauri, where the mirror fallback shows the full frame.
  const { view, stageProps } = useViewControls();
  const cubeInputRef = useRef<HTMLInputElement | null>(null);
  // Temporal denoise (video targets only): a pipeline stage after the doc,
  // blending each graded frame against the previous graded frame host-side;
  // the host restarts the chain on a seek or source change.
  const [temporalDenoise, setTemporalDenoise] = useState(0);
  const [exportNote, setExportNote] = useState<string | null>(null);
  // Monotonic preview sequence: only the latest request may publish a frame.
  const previewSeq = useRef(0);
  // Graded frames render through a grade_preview viewport (WGPU migration
  // Phase 3): the target (still image, or one decoded video frame) is a
  // reference; doc changes flow as viewport state. Null outside Tauri — the
  // mirror fallback stays. The stage anchors the native surface window
  // (surface swap): slider ticks then present with no PNG hop.
  const underlayAnchorRef = useRef<HTMLDivElement | null>(null);
  const renderGraded = useGradeViewport(
    { imagePath, videoPath, videoTimestampSec, nodeId },
    1280,
    underlayAnchorRef,
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // The ungraded base renders through the same grade viewport with the
      // identity document: it warms the viewport's cached source proxy for
      // the doc renders that follow, and video targets show the exact frame
      // at the timestamp rather than the nearest poster.
      const frame = await renderGraded(EMPTY_DOC).catch(() => null);
      if (cancelled) return;
      if (frame) {
        setPresented(frame.presented);
        setUnderlay(frame.presented ? null : frame.data_url);
        return;
      }
      // Browser preview (no viewport transport): the thumbnail bridge keeps
      // an underlay available for the in-webview mirror fallback.
      const path = videoPath
        ? (await videoProbe(videoPath, videoTimestampSec)).poster_path
        : imagePath;
      if (!path || cancelled) return;
      const thumb = await generateThumbnail({ path, size: 1280 });
      if (!cancelled && thumb.data_url) setUnderlay(thumb.data_url);
    };
    load().catch(() => {
      /* no underlay: the backend preview may still work */
    });
    return () => {
      cancelled = true;
    };
  }, [imagePath, videoPath, videoTimestampSec, renderGraded]);

  const doc = useMemo(() => docFromOps(ops), [ops]);

  // Debounced live preview: backend kernel first, TS mirror as fallback.
  useEffect(() => {
    const seq = ++previewSeq.current;
    const timer = window.setTimeout(async () => {
      setPreviewError(null);
      if (videoPath || imagePath) {
        try {
          const result = await renderGraded(doc, view, videoPath ? temporalDenoise : 0);
          if (previewSeq.current !== seq) return;
          if (result) {
            setPresented(result.presented);
            setPreview(result.presented ? null : result.data_url);
            setBackend(deviceReportFromViewportBackend(result.backend));
            return;
          }
        } catch (err) {
          if (previewSeq.current !== seq) return;
          setPreviewError(String(err));
        }
      }
      if (!underlay) return;
      try {
        const mirrored = await mirrorPreview(underlay, doc);
        if (previewSeq.current !== seq) return;
        if (mirrored) {
          setPreview(mirrored);
          setBackend("mirror");
        }
      } catch {
        /* keep the previous frame */
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [doc, view, imagePath, videoPath, videoTimestampSec, underlay, renderGraded, temporalDenoise]);

  const updateOp = useCallback((index: number, next: GradeOp) => {
    setOps((prev) => prev.map((op, i) => (i === index ? next : op)));
  }, []);
  const removeOp = useCallback((index: number) => {
    setOps((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const moveOp = useCallback((index: number, delta: -1 | 1) => {
    setOps((prev) => {
      const j = index + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }, []);

  const loadCube = useCallback(async (file: File) => {
    try {
      const op = parseCube(await file.text());
      setOps((prev) => [...prev, op]);
    } catch (err) {
      setPreviewError(String(err));
    }
  }, []);

  const handleApply = () => {
    onCommit({ gradeDoc: JSON.stringify(docFromOps(ops)) });
  };

  const handleExportCube = useCallback(async () => {
    setExportNote(null);
    try {
      const result = await gradeExportCube(docFromOps(ops));
      if (!result) return; // browser preview: no backend to bake with
      const skipped = result.skipped_spatial_ops + result.dropped_masks;
      setExportNote(
        `${t("grade.exportCubeDone")} ${result.path}` +
          (skipped > 0 ? ` · ${skipped} ${t("grade.exportCubeSkipped")}` : ""),
      );
    } catch (err) {
      setExportNote(String(err));
    }
  }, [ops, t]);

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
  ) => (
    <label className="field" key={label}>
      <span>{label}</span>
      <span className="slider-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output>{value}</output>
      </span>
    </label>
  );

  const opLabel = (kind: GradeOp["type"]): string => {
    const key = OP_LABEL_KEYS[kind];
    return key ? t(key) : kind;
  };

  const renderOp = (op: GradeOp, i: number) => {
    switch (op.type) {
      case "exposure":
        return slider(t("grade.ev"), op.ev, -4, 4, 0.05, (ev) => updateOp(i, { ...op, ev }));
      case "white_balance_k":
        return (
          <>
            {slider(t("grade.tempK"), op.temp_k, 2000, 12000, 50, (temp_k) => updateOp(i, { ...op, temp_k }))}
            {slider(t("grade.tint"), op.tint, -1, 1, 0.01, (tint) => updateOp(i, { ...op, tint }))}
          </>
        );
      case "contrast":
        return (
          <>
            {slider(t("grade.amount"), op.amount, 0, 2, 0.01, (amount) => updateOp(i, { ...op, amount }))}
            {slider(t("grade.pivot"), op.pivot, 0, 1, 0.01, (pivot) => updateOp(i, { ...op, pivot }))}
          </>
        );
      case "saturation":
        return slider(t("grade.amount"), op.amount, -1, 1, 0.01, (amount) => updateOp(i, { ...op, amount }));
      case "sharpen":
        return (
          <>
            {slider(t("grade.amount"), op.amount, 0, 2, 0.01, (amount) => updateOp(i, { ...op, amount }))}
            {slider(t("grade.radius"), op.radius ?? 1, 1, MAX_RADIUS, 1, (radius) => updateOp(i, { ...op, radius }))}
          </>
        );
      case "denoise":
        return (
          <>
            {slider(t("grade.amount"), op.amount, 0, 1, 0.01, (amount) => updateOp(i, { ...op, amount }))}
            {slider(t("grade.radius"), op.radius ?? 1, 1, MAX_RADIUS, 1, (radius) => updateOp(i, { ...op, radius }))}
          </>
        );
      case "film_grain":
        return (
          <>
            {slider(t("grade.amount"), op.amount, 0, 1, 0.01, (amount) => updateOp(i, { ...op, amount }))}
            <label className="field">
              <span>{t("grade.seed")}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={op.seed}
                onChange={(e) => updateOp(i, { ...op, seed: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              />
            </label>
          </>
        );
      case "blur":
        return slider(t("grade.sigma"), op.sigma, 0, MAX_BLUR_SIGMA, 0.1, (sigma) => updateOp(i, { ...op, sigma }));
      case "vignette":
        return (
          <>
            {slider(t("grade.amount"), op.amount, -1, 1, 0.01, (amount) => updateOp(i, { ...op, amount }))}
            {slider(t("grade.midpoint"), op.midpoint ?? 0.5, 0, 1, 0.01, (midpoint) => updateOp(i, { ...op, midpoint }))}
            {slider(t("grade.feather"), op.feather ?? 0.5, 0.001, 1, 0.01, (feather) => updateOp(i, { ...op, feather }))}
          </>
        );
      case "rgb_mixer": {
        const rows = [
          ["red", op.red],
          ["green", op.green],
          ["blue", op.blue],
        ] as const;
        return (
          <>
            {rows.map(([channel, weights]) =>
              op.monochrome && channel !== "red" ? null : (
                <div className="field" key={channel}>
                  <span>{t(`grade.mixer_${channel}`)}</span>
                  {([0, 1, 2] as const).map((c) => (
                    <span className="slider-row" key={c}>
                      <input
                        type="range"
                        min={-2}
                        max={2}
                        step={0.01}
                        value={weights[c]}
                        onChange={(e) => {
                          const next = [...weights] as [number, number, number];
                          next[c] = Number(e.target.value);
                          updateOp(i, { ...op, [channel]: next });
                        }}
                      />
                      <output>{weights[c]}</output>
                    </span>
                  ))}
                </div>
              ),
            )}
            <label className="field checkbox-row">
              <input
                type="checkbox"
                checked={op.monochrome}
                onChange={(e) => updateOp(i, { ...op, monochrome: e.target.checked })}
              />
              <span>{t("grade.monochrome")}</span>
            </label>
          </>
        );
      }
      case "color_ranges":
        return (
          <>
            {op.ranges.map((r, ri) => (
              <div className="field grade-warp-point" key={r.range}>
                <span>{t(`grade.range_${r.range}`)}</span>
                {(
                  [
                    ["hue", -180, 180, 1],
                    ["saturation", -1, 1, 0.01],
                    ["lightness", -1, 1, 0.01],
                  ] as const
                ).map(([key, min, max, step]) => (
                  <span className="slider-row" key={key}>
                    <small className="muted">{t(`grade.range_${key}`)}</small>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={r[key]}
                      onChange={(e) => {
                        const ranges: RangeAdjust[] = op.ranges.map((q, j) =>
                          j === ri ? { ...q, [key]: Number(e.target.value) } : q,
                        );
                        updateOp(i, { ...op, ranges });
                      }}
                    />
                    <output>{r[key]}</output>
                  </span>
                ))}
              </div>
            ))}
            <label className="field checkbox-row">
              <input
                type="checkbox"
                checked={op.monochrome ?? false}
                onChange={(e) => updateOp(i, { ...op, monochrome: e.target.checked })}
              />
              <span>{t("grade.monochrome")}</span>
            </label>
          </>
        );
      case "color_warper":
        return (
          <>
            {op.points.map((p, pi) => (
              <div className="field grade-warp-point" key={pi}>
                <span>
                  {t("grade.warpPoint")} {pi + 1}
                  <button
                    type="button"
                    className="grade-op-remove"
                    title={t("grade.removePoint")}
                    onClick={() =>
                      updateOp(i, { ...op, points: op.points.filter((_, j) => j !== pi) })
                    }
                  >
                    ✕
                  </button>
                </span>
                {(
                  [
                    ["hue", 0, 360, 1],
                    ["sat", 0, 1, 0.01],
                    ["hue_shift", -180, 180, 1],
                    ["sat_scale", 0, 4, 0.01],
                    ["hue_radius", 1, 180, 1],
                    ["sat_radius", 0.01, 1, 0.01],
                  ] as const
                ).map(([key, min, max, step]) => (
                  <span className="slider-row" key={key}>
                    <small className="muted">{t(`grade.warp_${key}`)}</small>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={p[key]}
                      onChange={(e) => {
                        const points = op.points.map((q, j) =>
                          j === pi ? { ...q, [key]: Number(e.target.value) } : q,
                        );
                        updateOp(i, { ...op, points });
                      }}
                    />
                    <output>{p[key]}</output>
                  </span>
                ))}
              </div>
            ))}
            <button
              type="button"
              onClick={() => updateOp(i, { ...op, points: [...op.points, defaultWarpPoint()] })}
            >
              {t("grade.addPoint")}
            </button>
          </>
        );
      case "lut1d":
      case "lut3d":
        return (
          <div className="field">
            <small className="muted">
              {t(op.type === "lut1d" ? "grade.lut1dInfo" : "grade.lut3dInfo")} · {op.size}
            </small>
          </div>
        );
      default:
        // Ops authored elsewhere (e.g. curves) pass through unedited.
        return (
          <div className="field">
            <small className="muted">{t("grade.opUneditable")}</small>
          </div>
        );
    }
  };

  return (
    <div className="mask-edit-body grade-panel">
      <div className="crop-edit-stage-wrap">
        <div className={`crop-edit-stage${presented ? " presented" : ""}`} {...stageProps}>
          <div ref={underlayAnchorRef} className="crop-edit-underlay-anchor" />
          {preview || underlay ? (
            <img className="crop-edit-img" src={preview ?? underlay ?? undefined} alt="preview" draggable={false} />
          ) : presented ? null : (
            <div className="crop-edit-img placeholder" />
          )}
        </div>
        <small className="muted">
          {previewError ?? t("grade.previewHint")}
          {backend ? (
            <span title={backend === "mirror" ? undefined : describeDeviceReport(backend)}>
              {" · "}
              {((key) => (key ? t(key) : backend === "mirror" ? backend : backend.used))(
                BACKEND_LABEL_KEYS[backend === "mirror" ? "mirror" : backend.used],
              )}
              {backend !== "mirror" && backend.fallbackReason ? " ⚠" : null}
            </span>
          ) : null}
          {view.zoom > 1 ? <> · {Math.round(view.zoom * 100)}%</> : null}
        </small>
      </div>

      <div className="mask-edit-controls grade-edit-controls">
        {videoPath
          ? slider(t("grade.temporalDenoise"), temporalDenoise, 0, 1, 0.05, setTemporalDenoise)
          : null}

        {ops.map((op, i) => (
          <div className="grade-op" key={i}>
            <div className="grade-op-head">
              <span>{opLabel(op.type)}</span>
              <span className="grade-op-buttons">
                <button type="button" title={t("grade.moveUp")} onClick={() => moveOp(i, -1)}>
                  ↑
                </button>
                <button type="button" title={t("grade.moveDown")} onClick={() => moveOp(i, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  className="grade-op-remove"
                  title={t("grade.removeOp")}
                  onClick={() => removeOp(i)}
                >
                  ✕
                </button>
              </span>
            </div>
            {renderOp(op, i)}
          </div>
        ))}

        <div className="field grade-add-row">
          <select value={addKind} onChange={(e) => setAddKind(e.target.value as AddableOp)}>
            {ADDABLE_OPS.map((kind) => (
              <option key={kind} value={kind}>
                {opLabel(kind)}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setOps((prev) => [...prev, defaultOp(addKind)])}>
            {t("grade.addOp")}
          </button>
          <button type="button" title={t("grade.loadCubeTitle")} onClick={() => cubeInputRef.current?.click()}>
            {t("grade.loadCube")}
          </button>
          <button type="button" title={t("grade.exportCubeTitle")} onClick={() => void handleExportCube()}>
            {t("grade.exportCube")}
          </button>
          <input
            ref={cubeInputRef}
            type="file"
            accept=".cube"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void loadCube(file);
              e.target.value = "";
            }}
          />
        </div>

        {exportNote ? (
          <div className="field">
            <small className="muted">{exportNote}</small>
          </div>
        ) : null}

        <div className="field grade-apply-row">
          <button type="button" className="primary" onClick={handleApply} title={t("grade.applyTitle")}>
            {t(applyLabelKey ?? "grade.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
