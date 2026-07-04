import { useState } from "react";
import { useT } from "../i18n";
import { apiProfilesFor, loadRegistry, localModelsFor } from "./backendRegistry";
import { ModelManagerModal } from "./ModelManagerModal";

interface PromptModelSelectProps {
  /** The prompt node's current params (mode / refs are derived from them). */
  params: Record<string, unknown>;
  /** Writes one param on the node. */
  setParam: (key: string, value: unknown) => void;
  /** On a node card, inputs must not start a drag / pan the canvas. */
  compact?: boolean;
}

// Combined model dropdown for the Prompt card: one select covering "no
// optimization" (empty), the built-in rule-based local presets, and the
// manager's local models and API profiles for `prompt.rewrite`. Selection is
// mirrored into the legacy mode/ref params so both the TS and Rust runtimes
// keep working unchanged.
export function PromptModelSelect({ params, setParam, compact }: PromptModelSelectProps) {
  const t = useT();
  const [managerOpen, setManagerOpen] = useState(false);
  // Reloaded when the manager modal closes so edits show up without a re-mount.
  const [registry, setRegistry] = useState(() => loadRegistry());
  const cls = compact ? "nodrag nowheel" : undefined;

  const apiOptions = apiProfilesFor(registry, "prompt.rewrite");
  const localOptions = localModelsFor(registry, "prompt.rewrite");

  const mode = String(params.mode ?? "off");
  const localRef = String(params.local_model_ref ?? "");
  const value =
    mode === "api"
      ? `api:${String(params.api_profile_ref ?? "")}`
      : mode === "local"
        ? localRef
          ? `local:${localRef}`
          : "local"
        : "";
  const known =
    value === "" ||
    value === "local" ||
    apiOptions.some((p) => `api:${p.ref}` === value) ||
    localOptions.some((m) => `local:${m.ref}` === value);

  const apply = (next: string) => {
    if (next === "") {
      setParam("mode", "off");
      return;
    }
    if (next === "local" || next.startsWith("local:")) {
      setParam("mode", "local");
      setParam("local_model_ref", next === "local" ? "" : next.slice("local:".length));
      return;
    }
    const profile = apiOptions.find((p) => `api:${p.ref}` === next);
    if (!profile) return;
    setParam("mode", "api");
    setParam("api_profile_ref", profile.ref);
    if (profile.provider_kind) setParam("provider", profile.provider_kind);
    if (profile.default_model) setParam("model", profile.default_model);
    setParam("credentials_ref", profile.credentials_ref);
  };

  return (
    <span className="path-row">
      <select className={cls} value={known ? value : ""} onChange={(e) => apply(e.target.value)}>
        <option value="">{t("models.selector.promptNone")}</option>
        <option value="local">{t("models.selector.builtinLocal")}</option>
        {localOptions.length > 0 && (
          <optgroup label={t("models.selector.groupLocal")}>
            {localOptions.map((m) => (
              <option key={m.ref} value={`local:${m.ref}`}>
                {m.display_name}
                {m.engine ? ` (${m.engine})` : ""}
              </option>
            ))}
          </optgroup>
        )}
        {apiOptions.length > 0 && (
          <optgroup label={t("models.selector.groupApi")}>
            {apiOptions.map((p) => (
              <option key={p.ref} value={`api:${p.ref}`}>
                {p.display_name}
                {p.provider_kind ? ` (${p.provider_kind})` : ""}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button
        type="button"
        className={compact ? "nodrag" : undefined}
        onClick={() => setManagerOpen(true)}
      >
        {t("models.selector.manage")}
      </button>
      {managerOpen && (
        <ModelManagerModal
          capability="prompt.rewrite"
          onClose={() => {
            setManagerOpen(false);
            setRegistry(loadRegistry());
          }}
        />
      )}
    </span>
  );
}
