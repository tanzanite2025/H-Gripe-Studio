// Premiere-style Properties panel for the selected visual clip: editable
// Transform (position / anchor / scale / rotation / opacity) and Crop
// sections over the per-clip property document. Purely presentational —
// the document lives in the production store and arrives via props.

import { useT, type MsgKey } from "../i18n";
import { defaultClipProperties, type ClipProperties } from "./clipProps";

export interface ClipPropertiesPanelProps {
  clipName: string;
  props: ClipProperties;
  onChange: (next: ClipProperties) => void;
}

function ResetIcon() {
  return (
    <svg className="production-props-reset-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 9a8 8 0 1 1-1 5" />
      <path d="M5 4v5h5" />
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

export function ClipPropertiesPanel({ clipName, props, onChange }: ClipPropertiesPanelProps) {
  const t = useT();
  const { transform, crop } = props;
  const setTransform = (patch: Partial<ClipProperties["transform"]>) =>
    onChange({ ...props, transform: { ...transform, ...patch } });
  const setCrop = (patch: Partial<ClipProperties["crop"]>) =>
    onChange({ ...props, crop: { ...crop, ...patch } });
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
            onClick={() => onChange({ ...props, transform: defaultClipProperties().transform })}
          >
            <ResetIcon />
          </button>
        </header>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsPosition")}</span>
          <NumberField labelKey="drawer.propsX" value={transform.position.x} onCommit={(x) => setTransform({ position: { ...transform.position, x } })} />
          <NumberField labelKey="drawer.propsY" value={transform.position.y} onCommit={(y) => setTransform({ position: { ...transform.position, y } })} />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsAnchor")}</span>
          <NumberField labelKey="drawer.propsX" value={transform.anchor.x} onCommit={(x) => setTransform({ anchor: { ...transform.anchor, x } })} />
          <NumberField labelKey="drawer.propsY" value={transform.anchor.y} onCommit={(y) => setTransform({ anchor: { ...transform.anchor, y } })} />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsScale")}</span>
          <NumberField value={transform.scalePct} suffix="%" onCommit={(scalePct) => setTransform({ scalePct })} />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsRotation")}</span>
          <NumberField value={transform.rotationDeg} suffix="°" onCommit={(rotationDeg) => setTransform({ rotationDeg })} />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsOpacity")}</span>
          <NumberField value={transform.opacityPct} suffix="%" onCommit={(opacityPct) => setTransform({ opacityPct })} />
        </div>
      </section>
      <section className="production-props-section">
        <header>
          <h4>{t("drawer.propsCrop")}</h4>
          <button
            type="button"
            className="production-props-reset"
            title={t("drawer.propsResetSection")}
            onClick={() => onChange({ ...props, crop: defaultClipProperties().crop })}
          >
            <ResetIcon />
          </button>
        </header>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsCropLeft")}</span>
          <NumberField value={crop.leftPct} step={0.5} suffix="%" onCommit={(leftPct) => setCrop({ leftPct })} />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsCropTop")}</span>
          <NumberField value={crop.topPct} step={0.5} suffix="%" onCommit={(topPct) => setCrop({ topPct })} />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsCropRight")}</span>
          <NumberField value={crop.rightPct} step={0.5} suffix="%" onCommit={(rightPct) => setCrop({ rightPct })} />
        </div>
        <div className="production-props-row">
          <span className="production-props-row-label">{t("drawer.propsCropBottom")}</span>
          <NumberField value={crop.bottomPct} step={0.5} suffix="%" onCommit={(bottomPct) => setCrop({ bottomPct })} />
        </div>
      </section>
    </div>
  );
}
