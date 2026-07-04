import { useContext, useState } from "react";
import type { Node } from "@xyflow/react";
import { nodeSpec } from "../graph/nodeSpecs";
import { LOWERED_CARD_ROWS } from "../graph/lowering";
import { localizeSpec } from "../graph/nodeSpecsI18n";
import { LangContext, useT } from "../i18n";
import {
  lastEngineProbe,
  probeEnginesCached,
  type EngineProbeReport,
} from "../bridge/engineProbe";
import { ParamField } from "./ParamField";
import { BackendSelector } from "../models/BackendSelector";
import { LocalModelSelector } from "../models/LocalModelSelector";
import type { ModelCapability } from "../models/backendRegistry";
import { OutputPicker } from "./OutputPicker";
import { MediaViewer } from "./MediaViewer";
import type { HgripeNodeData } from "./HgripeNode";

// Which probe `node_kind` covers a param's `engine` select: `engine` is the
// node's own kind; an integrated card's `<row>.engine` is the leaf kind that
// row lowers to (the probe reports leaf kinds, not card kinds).
function engineProbeKind(kind: string, paramKey: string): string | null {
  if (paramKey === "engine") return kind;
  if (!paramKey.endsWith(".engine")) return null;
  const row = paramKey.slice(0, -".engine".length);
  return LOWERED_CARD_ROWS[kind]?.find((def) => def.row === row)?.kind ?? null;
}

// Which manager capability a node's backend selector filters by. Selection is
// stored as `api_profile_ref`; legacy provider/model/credentials_ref params are
// still written alongside so the existing executors keep working (backend
// selection contract plan, migration notes).
function backendCapability(kind: string, params: Record<string, unknown>): ModelCapability | null {
  if (kind === "generate")
    return String(params.operation ?? "") === "image.edit" ? "image.edit" : "image.generate";
  if (kind === "promptOptimize" && String(params.mode ?? "") === "api") return "prompt.rewrite";
  if (kind === "detailRepaint") return "image.edit";
  return null;
}

// Which manager capability a node's local model selector filters by. Selection
// stores `local_model_ref` and mirrors the node's device/precision fields
// where present; the legacy `engine` select stays as the advanced escape hatch.
function localModelCapability(
  kind: string,
  params: Record<string, unknown>,
): ModelCapability | null {
  if (kind === "subjectMask") return "mask.subject";
  if (kind === "refineMaskEdge") return "matte.refine";
  if (kind === "imageEnhance") return "image.upscale";
  if (kind === "matchLightColor") return "image.enhance";
  if (
    kind === "detailRepaint" &&
    ["sd_inpaint", "sdxl_inpaint", "flux_fill"].includes(String(params.engine ?? ""))
  )
    return "image.inpaint";
  return null;
}

interface InspectorProps {
  node: Node;
  onParamChange: (nodeId: string, key: string, value: unknown) => void;
  onClose?: () => void;
}

// Right-side panel. Mounted only while a node is selected (the shell renders a
// plain placeholder otherwise), so no inspector state or effects exist while
// nothing is inspected. Full-resolution media preview belongs here (not inside
// the node card), so the canvas stays light and previews never blow up node
// size.
export function Inspector({ node, onParamChange, onClose }: InspectorProps) {
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  // Engine dropdowns read only the node spec — selecting an engine is picking
  // a ref, not probing it. The capability report exists only after the user
  // explicitly checks (here or in a diagnostics view); until then options stay
  // enabled and the run path does its own strict validation + fallback.
  const [engineProbe, setEngineProbe] = useState<EngineProbeReport | null>(lastEngineProbe);
  const [probing, setProbing] = useState(false);
  const lang = useContext(LangContext);
  const t = useT();

  const nodeKind = String((node.data as HgripeNodeData).kind);
  const hasEngineParam =
    nodeKind !== "group" &&
    nodeSpec(nodeKind).params.some((p) => engineProbeKind(nodeKind, p.key) !== null);

  const runEngineCheck = () => {
    setProbing(true);
    probeEnginesCached(true)
      .then((report) => setEngineProbe(report))
      .catch(() => setEngineProbe(null))
      .finally(() => setProbing(false));
  };

  const data = node.data as HgripeNodeData;

  // Group container: no ports/params, just a rename field.
  if (data.kind === "group") {
    return (
      <aside className="inspector">
        <div className="inspector-head">
          <h2>{t("inspector.group")}</h2>
          {onClose && (
            <button type="button" className="inspector-close" onClick={onClose} title="Close inspector">
              x
            </button>
          )}
        </div>
        <p className="muted">{t("inspector.groupDesc")}</p>
        <label className="field">
          <span>{t("inspector.label")}</span>
          <input
            value={String(data.params.label ?? "")}
            onChange={(e) => onParamChange(node.id, "label", e.target.value)}
          />
        </label>
      </aside>
    );
  }

  const spec = localizeSpec(nodeSpec(data.kind), lang);

  // A param can declare `visibleWhen` to hide itself unless a sibling param has
  // one of the listed values (e.g. show API fields only when mode === "api").
  // Params marked `inline` already live on the node card; repeating them here
  // creates two edit surfaces for one value and makes the canvas feel incoherent.
  const isVisible = (p: (typeof spec.params)[number]) =>
    !p.inline &&
    (!p.visibleWhen || p.visibleWhen.in.includes(String(data.params[p.visibleWhen.param] ?? "")));

  const capability = backendCapability(spec.kind, data.params);
  const localCapability = localModelCapability(spec.kind, data.params);
  const hasParam = (key: string) => spec.params.some((p) => p.key === key);
  const normalParams = spec.params.filter((p) => isVisible(p) && !p.advanced);
  const advancedParams = spec.params.filter((p) => isVisible(p) && p.advanced);

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <h2>{spec.title}</h2>
        {onClose && (
          <button type="button" className="inspector-close" onClick={onClose} title="Close inspector">
            x
          </button>
        )}
      </div>
      <p className="muted">{spec.description}</p>

      {capability && (
        <BackendSelector
          capability={capability}
          value={String(data.params.api_profile_ref ?? "")}
          onApply={(profile) => {
            onParamChange(node.id, "api_profile_ref", profile.ref);
            if (profile.provider_kind) onParamChange(node.id, "provider", profile.provider_kind);
            if (profile.default_model) onParamChange(node.id, "model", profile.default_model);
            onParamChange(node.id, "credentials_ref", profile.credentials_ref);
          }}
        />
      )}

      {localCapability && (
        <LocalModelSelector
          capability={localCapability}
          value={String(data.params.local_model_ref ?? "")}
          onApply={(model) => {
            onParamChange(node.id, "local_model_ref", model.ref);
            if (hasParam("device") && model.device_policy !== "directml")
              onParamChange(node.id, "device", model.device_policy);
            if (hasParam("precision")) onParamChange(node.id, "precision", model.precision_policy);
          }}
        />
      )}

      {hasEngineParam && (
        <div className="field engine-check">
          <button type="button" className="engine-check-btn" onClick={runEngineCheck} disabled={probing}>
            {probing ? t("inspector.engineChecking") : t("inspector.engineCheck")}
          </button>
          {!engineProbe && !probing && (
            <small className="hint">{t("inspector.engineUnchecked")}</small>
          )}
        </div>
      )}

      {normalParams.map((p) => {
        const raw = data.params[p.key];
        const onChange = (v: unknown) => onParamChange(node.id, p.key, v);
        // For the opt-in `engine` select, grey out engines the probe reports as
        // unavailable on this box (the CPU/`rules` baseline stays enabled). A
        // probe that did not run (browser preview, error) leaves all enabled.
        const probeKind = engineProbeKind(data.kind, p.key);
        const card = probeKind
          ? engineProbe?.cards.find((c) => c.node_kind === probeKind)
          : undefined;
        const optionStates =
          card && !card.error && Object.keys(card.engines).length > 0 ? card.engines : undefined;
        const selectedState = optionStates?.[String(raw ?? "")];
        const selectedUnavailable = selectedState && !selectedState.available;
        // For an available GPU-capable engine, note whether it would actually
        // run on a CUDA device or fall back to CPU on this box (machine probe).
        const runtime = engineProbe?.runtime;
        const deviceNote =
          selectedState?.available && selectedState.accelerated && runtime
            ? runtime.cuda_available
              ? t("inspector.engineGpu")
              : t("inspector.engineCpuFallback")
            : undefined;
        return (
          <label key={p.key} className="field">
            <span>{p.label}</span>
            <ParamField spec={p} value={raw} onChange={onChange} optionStates={optionStates} />
            {p.control === "path" && (
              <OutputPicker
                kind={spec.kind === "psdTemplate" ? "template" : "image"}
                onPick={(path) => onChange(path)}
              />
            )}
            {selectedUnavailable && (
              <small className="hint warn">{t("inspector.engineUnavailable")}</small>
            )}
            {deviceNote && <small className="hint">{deviceNote}</small>}
            {p.hint && <small className="hint">{p.hint}</small>}
          </label>
        );
      })}

      {advancedParams.length > 0 && (
        <details className="field inspector-advanced">
          <summary>{t("inspector.advanced")}</summary>
          {advancedParams.map((p) => (
            <label key={p.key} className="field">
              <span>{p.label}</span>
              <ParamField
                spec={p}
                value={data.params[p.key]}
                onChange={(v) => onParamChange(node.id, p.key, v)}
              />
              {p.hint && <small className="hint">{p.hint}</small>}
            </label>
          ))}
        </details>
      )}

      {data.imagePath && (
        <div className="field">
          <span>{t("inspector.output")}</span>
          <button
            type="button"
            className="inspector-img-btn"
            onClick={() => setViewerPath(data.imagePath ?? null)}
            title={t("inspector.viewFull")}
          >
            {data.thumbnail ? (
              <img className="inspector-img" src={data.thumbnail} alt="output" />
            ) : (
              <div className="inspector-img placeholder">{t("inspector.viewFull")}</div>
            )}
          </button>
          <code className="path">{data.imagePath}</code>
        </div>
      )}

      {viewerPath && <MediaViewer path={viewerPath} onClose={() => setViewerPath(null)} />}
    </aside>
  );
}
