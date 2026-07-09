// Premiere-style Properties panel for the selected visual clip: editable
// Transform (position / anchor / scale / rotation / opacity) and Crop
// sections over the per-clip property document, each scalar with a keyframe
// diamond that toggles a key at the playhead (values shown are evaluated at
// the playhead, `keyframes.ts` semantics). Purely presentational — the
// document lives in the production store and arrives via props.

import { useT, type MsgKey } from "../i18n";
import type { ClipProperties } from "./clipProps";
import {
  evaluateClipProp,
  hasKeyframeAt,
  keyframesFor,
  resetClipPropsSection,
  setClipPropValueAt,
  toggleKeyframe,
  type ClipPropPath,
} from "./keyframes";

export interface ClipPropertiesPanelProps {
  clipName: string;
  props: ClipProperties;
  /** Playhead time inside the clip (clip-local seconds). */
  clipLocalSec: number;
  onChange: (next: ClipProperties) => void;
}

/** Keyframe toggle capture radius: half a frame at 24fps. */
const KEYFRAME_EPS = 1 / 48;

function ResetIcon() {
  return (
    <svg className="production-props-reset-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 9a8 8 0 1 1-1 5" />
      <path d="M5 4v5h5" />
    </svg>
  );
}

function DiamondIcon() {
  return (
    <svg className="production-props-diamond-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3 21 12l-9 9-9-9z" />
    </svg>
  );
}

function NumberField({
  labelKey,
  value,
  step,
  suffix,
  onCommit,
}: {
  labelKey?: MsgKey;
  value: number;
  step?: number;
  suffix?: string;
  onCommit: (value: number) => void;
}) {
  const t = useT();
  return (
    <label className="production-props-field">
      {labelKey ? <span className="production-props-field-label">{t(labelKey)}</span> : null}
      <input
        type="number"
        value={Number.isInteger(value) ? value : Number(value.toFixed(2))}
        step={step ?? 1}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onCommit(next);
        }}
      />
      {suffix ? <span className="production-props-field-suffix">{suffix}</span> : null}
    </label>
  );
}

export function ClipPropertiesPanel({ clipName, props, clipLocalSec, onChange }: ClipPropertiesPanelProps) {
  const t = useT();

  const valueOf = (path: ClipPropPath) => evaluateClipProp(props, path, clipLocalSec);
  const commit = (path: ClipPropPath) => (value: number) =>
    onChange(setClipPropValueAt(props, path, clipLocalSec, value, KEYFRAME_EPS));

  function Diamond({ path }: { path: ClipPropPath }) {
    const animated = keyframesFor(props, path).length > 0;
    const onKey = hasKeyframeAt(props, path, clipLocalSec, KEYFRAME_EPS);
    return (
      <button
        type="button"
        className={`production-props-diamond${animated ? " animated" : ""}${onKey ? " on-key" : ""}`}
        title={t("drawer.propsKeyframeToggle")}
        aria-pressed={onKey}
        onClick={() => onChange(toggleKeyframe(props, path, clipLocalSec, KEYFRAME_EPS))}
      >
        <DiamondIcon />
      </button>
    );
  }

  return (
    <div className="production-props">
      <div className="production-props-clip" title={clipName}>
        {clipName}
      </div>
      <section className="production-props-section">
        <header>
          <h4>{t("drawer.propsTransform")}</h4>
          <button
            type="button"
            className="production-props-reset"
            title={t("drawer.propsResetSection")}
            onClick={() => onChange(resetClipPropsSection(props, "transform"))}
          >
            <ResetIcon />
          </button>
        </header>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsPosition")}</span>
          <NumberField labelKey="drawer.propsX" value={valueOf("transform.position.x")} onCommit={commit("transform.position.x")} />
          <Diamond path="transform.position.x" />
          <NumberField labelKey="drawer.propsY" value={valueOf("transform.position.y")} onCommit={commit("transform.position.y")} />
          <Diamond path="transform.position.y" />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsAnchor")}</span>
          <NumberField labelKey="drawer.propsX" value={valueOf("transform.anchor.x")} onCommit={commit("transform.anchor.x")} />
          <Diamond path="transform.anchor.x" />
          <NumberField labelKey="drawer.propsY" value={valueOf("transform.anchor.y")} onCommit={commit("transform.anchor.y")} />
          <Diamond path="transform.anchor.y" />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsScale")}</span>
          <NumberField value={valueOf("transform.scalePct")} suffix="%" onCommit={commit("transform.scalePct")} />
          <Diamond path="transform.scalePct" />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsRotation")}</span>
          <NumberField value={valueOf("transform.rotationDeg")} suffix="°" onCommit={commit("transform.rotationDeg")} />
          <Diamond path="transform.rotationDeg" />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsOpacity")}</span>
          <NumberField value={valueOf("transform.opacityPct")} suffix="%" onCommit={commit("transform.opacityPct")} />
          <Diamond path="transform.opacityPct" />
        </div>
      </section>
      <section className="production-props-section">
        <header>
          <h4>{t("drawer.propsCrop")}</h4>
          <button
            type="button"
            className="production-props-reset"
            title={t("drawer.propsResetSection")}
            onClick={() => onChange(resetClipPropsSection(props, "crop"))}
          >
            <ResetIcon />
          </button>
        </header>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsCropLeft")}</span>
          <NumberField value={valueOf("crop.leftPct")} step={0.5} suffix="%" onCommit={commit("crop.leftPct")} />
          <Diamond path="crop.leftPct" />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsCropTop")}</span>
          <NumberField value={valueOf("crop.topPct")} step={0.5} suffix="%" onCommit={commit("crop.topPct")} />
          <Diamond path="crop.topPct" />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsCropRight")}</span>
          <NumberField value={valueOf("crop.rightPct")} step={0.5} suffix="%" onCommit={commit("crop.rightPct")} />
          <Diamond path="crop.rightPct" />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsCropBottom")}</span>
          <NumberField value={valueOf("crop.bottomPct")} step={0.5} suffix="%" onCommit={commit("crop.bottomPct")} />
          <Diamond path="crop.bottomPct" />
        </div>
      </section>
    </div>
  );
}
