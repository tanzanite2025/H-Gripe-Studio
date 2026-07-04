import { useState } from "react";
import { useT } from "../i18n";
import {
  loadRegistry,
  localModelsFor,
  type LocalModelEntry,
  type ModelCapability,
} from "./backendRegistry";
import { ModelManagerModal } from "./ModelManagerModal";

interface LocalModelSelectorProps {
  /** Only local models declaring this capability are offered. */
  capability: ModelCapability;
  /** The node's current `local_model_ref` param. */
  value: string;
  /** Applies the chosen managed local model to the node. */
  onApply: (model: LocalModelEntry) => void;
  /** Overrides the default field label (e.g. a card row prefix). */
  label?: string;
}

// Capability-filtered local model dropdown backed by the system model manager
// (the local twin of BackendSelector; same manager selector API so all cards
// show consistent options for one capability).
export function LocalModelSelector({ capability, value, onApply, label }: LocalModelSelectorProps) {
  const t = useT();
  const [managerOpen, setManagerOpen] = useState(false);
  const [registry, setRegistry] = useState(() => loadRegistry());

  const options = localModelsFor(registry, capability);
  const dangling = value !== "" && !options.some((m) => m.ref === value);

  return (
    <label className="field">
      <span>{label ?? t("models.selector.localLabel")}</span>
      <div className="path-row">
        <select
          value={dangling ? "" : value}
          onChange={(e) => {
            const m = options.find((x) => x.ref === e.target.value);
            if (m) onApply(m);
          }}
        >
          <option value="">{t("models.selector.pickLocal")}</option>
          {options.map((m) => (
            <option key={m.ref} value={m.ref}>
              {m.display_name}
              {m.engine ? ` (${m.engine})` : ""}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setManagerOpen(true)}>
          {t("models.selector.manage")}
        </button>
      </div>
      {dangling ? (
        <small className="hint warn">
          {t("models.selector.dangling")}: {value}
        </small>
      ) : options.length === 0 ? (
        <small className="hint">{t("models.selector.localEmpty")}</small>
      ) : (
        <small className="hint">{t("models.selector.localHint")}</small>
      )}
      {managerOpen && (
        <ModelManagerModal
          capability={capability}
          onClose={() => {
            setManagerOpen(false);
            setRegistry(loadRegistry());
          }}
        />
      )}
    </label>
  );
}
