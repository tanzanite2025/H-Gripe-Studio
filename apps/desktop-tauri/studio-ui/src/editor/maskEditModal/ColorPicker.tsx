// PS-style colour picker dialog (拾色器): a saturation/value field, a hue
// strip, and linked HSB / RGB / hex inputs. Pure view state — the chosen
// colour lands on the caller through `onConfirm`.

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";

export interface Hsv {
  h: number; // 0..360
  s: number; // 0..100
  v: number; // 0..100
}

export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const sf = s / 100;
  const vf = v / 100;
  const c = vf * sf;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = vf - c;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rf) h = 60 * (((gf - bf) / d) % 6);
    else if (max === gf) h = 60 * ((bf - rf) / d + 2);
    else h = 60 * ((rf - gf) / d + 4);
  }
  h = ((h % 360) + 360) % 360;
  const s = max === 0 ? 0 : (d / max) * 100;
  return { h, s, v: max * 100 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

interface ColorPickerProps {
  title: string;
  /** The colour being replaced (`当前` swatch), as `#rrggbb`. */
  initial: string;
  onConfirm: (hex: string) => void;
  onCancel: () => void;
}

export function ColorPicker({ title, initial, onConfirm, onCancel }: ColorPickerProps) {
  const t = useT();
  const [hsv, setHsv] = useState<Hsv>(() => {
    const rgb = hexToRgb(initial) ?? [255, 255, 255];
    return rgbToHsv(...rgb);
  });
  const [r, g, b] = hsvToRgb(hsv);
  const hex = rgbToHex(r, g, b);
  // Free-typed hex draft (only applied when it parses).
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);

  const pickSv = useCallback((e: PointerEvent | React.PointerEvent) => {
    const el = svRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * 100;
    const v = (1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))) * 100;
    setHsv((prev) => ({ ...prev, s, v }));
  }, []);

  const pickHue = useCallback((e: PointerEvent | React.PointerEvent) => {
    const el = hueRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const h = (1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))) * 360;
    setHsv((prev) => ({ ...prev, h: Math.min(359.999, h) }));
  }, []);

  // Field / strip drags: capture the pointer so the drag keeps tracking
  // outside the element.
  const dragging = useRef<"sv" | "hue" | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragging.current === "sv") pickSv(e);
      else if (dragging.current === "hue") pickHue(e);
    };
    const onUp = () => {
      dragging.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [pickSv, pickHue]);

  const setChannel = (channel: "r" | "g" | "b", value: number) => {
    const nv = Math.max(0, Math.min(255, Math.round(value) || 0));
    const next: Record<string, number> = { r, g, b, [channel]: nv };
    setHsv(rgbToHsv(next.r, next.g, next.b));
  };

  const [hueR, hueG, hueB] = hsvToRgb({ h: hsv.h, s: 100, v: 100 });

  return (
    <div className="mask-color-picker-backdrop" onClick={onCancel}>
      <div className="mask-color-picker" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="mask-color-picker-title">
          <span>{title}</span>
          <button className="mask-color-picker-close" aria-label={t("mask.pickerCancel")} onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="mask-color-picker-body">
          <div
            ref={svRef}
            className="mask-color-picker-sv"
            style={{ backgroundColor: rgbToHex(hueR, hueG, hueB) }}
            onPointerDown={(e) => {
              dragging.current = "sv";
              pickSv(e);
            }}
          >
            <div
              className="mask-color-picker-sv-thumb"
              style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, borderColor: hsv.v > 60 ? "#000" : "#fff" }}
            />
          </div>
          <div
            ref={hueRef}
            className="mask-color-picker-hue"
            onPointerDown={(e) => {
              dragging.current = "hue";
              pickHue(e);
            }}
          >
            <div className="mask-color-picker-hue-thumb" style={{ top: `${100 - (hsv.h / 360) * 100}%` }} />
          </div>
          <div className="mask-color-picker-side">
            <div className="mask-color-picker-preview">
              <span className="muted">{t("mask.pickerNew")}</span>
              <span className="mask-color-picker-swatch" style={{ background: hex }} />
              <span className="mask-color-picker-swatch" style={{ background: initial }} />
              <span className="muted">{t("mask.pickerCurrent")}</span>
            </div>
            <div className="mask-color-picker-fields">
              <label>
                <span>H:</span>
                <input
                  type="number"
                  min={0}
                  max={360}
                  value={Math.round(hsv.h)}
                  onChange={(e) => setHsv((prev) => ({ ...prev, h: Math.max(0, Math.min(360, Number(e.target.value) || 0)) }))}
                />
                <span className="muted">°</span>
              </label>
              <label>
                <span>S:</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(hsv.s)}
                  onChange={(e) => setHsv((prev) => ({ ...prev, s: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
                />
                <span className="muted">%</span>
              </label>
              <label>
                <span>B:</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(hsv.v)}
                  onChange={(e) => setHsv((prev) => ({ ...prev, v: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
                />
                <span className="muted">%</span>
              </label>
              <label>
                <span>R:</span>
                <input type="number" min={0} max={255} value={r} onChange={(e) => setChannel("r", Number(e.target.value))} />
              </label>
              <label>
                <span>G:</span>
                <input type="number" min={0} max={255} value={g} onChange={(e) => setChannel("g", Number(e.target.value))} />
              </label>
              <label>
                <span>B:</span>
                <input type="number" min={0} max={255} value={b} onChange={(e) => setChannel("b", Number(e.target.value))} />
              </label>
              <label className="mask-color-picker-hex">
                <span>#</span>
                <input
                  type="text"
                  value={hexDraft ?? hex.slice(1)}
                  onChange={(e) => {
                    setHexDraft(e.target.value);
                    const rgb = hexToRgb(e.target.value);
                    if (rgb) setHsv(rgbToHsv(...rgb));
                  }}
                  onBlur={() => setHexDraft(null)}
                />
              </label>
            </div>
            <div className="mask-color-picker-actions">
              <button className="primary" onClick={() => onConfirm(hex)}>
                {t("mask.pickerOk")}
              </button>
              <button onClick={onCancel}>{t("mask.pickerCancel")}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
