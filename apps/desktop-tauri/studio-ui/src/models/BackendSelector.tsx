import { useState } from "react";
import { useT } from "../i18n";
import {
  apiProfilesFor,
  loadRegistry,
  type ApiProfileEntry,
  type ModelCapability,
} from "./backendRegistry";
import { ModelManagerModal } from "./ModelManagerModal";

interface BackendSelectorProps {
  /** Only profiles declaring this capability are offered. */
  capability: ModelCapability;
  /** The node's current `api_profile_ref` param. */
  value: string;
  /** Applies the chosen managed profile to the node. */
  onApply: (profile: ApiProfileEntry) => void;
}

// Capability-filtered API profile dropdown backed by the system model manager
// (backend selection contract plan: every card dropdown goes through the same
// manager selector API, storing a managed ref instead of raw provider fields).
export function BackendSelector({ capability, value, onApply }: BackendSelectorProps) {
  const t = useT();
  const [managerOpen, setManagerOpen] = useState(false);
  // Registry state is reloaded when the manager modal closes, so edits made
  // there show up in the dropdown without a full re-mount.
  const [registry, setRegistry] = useState(() => loadRegistry());

  const options = apiProfilesFor(registry, capability);
  const dangling = value !== "" && !options.some((p) => p.ref === value);

  return (
    <label className="field">
      <span>{t("models.selector.label")}</span>
      <div className="path-row">
        <select
          value={dangling ? "" : value}
          onChange={(e) => {
            const p = options.find((x) => x.ref === e.target.value);
            if (p) onApply(p);
          }}
        >
          <option value="">{t("models.selector.pick")}</option>
          {options.map((p) => (
            <option key={p.ref} value={p.ref}>
              {p.display_name}
              {p.provider_kind ? ` (${p.provider_kind})` : ""}
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
        <small className="hint">{t("models.selector.empty")}</small>
      ) : (
        <small className="hint">{t("models.selector.hint")}</small>
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
