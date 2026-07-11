import { useCallback, useEffect, useMemo, useState } from "react";

import { useT, type MsgKey } from "../i18n";
import {
  MODEL_CAPABILITIES,
  duplicateApiProfile,
  loadRegistry,
  removeApiProfile,
  removeLocalModel,
  saveRegistry,
  uniqueRef,
  upsertApiProfile,
  upsertLocalModel,
  type ApiProfileEntry,
  type BackendRegistry,
  type LocalModelEntry,
  type ModelCapability,
} from "./backendRegistry";
import { probeLocalModelHealth, testApiProfileHealth } from "./backendHealth";
import { API_PROFILE_PRESETS, profileFromPreset } from "./apiProfilePresets";
import { PresetProviderIcon } from "./providerIcons";

// The system "Models / APIs" manager modal
// (docs/plans/active/SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md): one global surface
// owning API profiles and local model bindings, so card-level dropdowns all
// read from the same registry. Probes are manual only — nothing here runs on
// app startup or when a dropdown opens.

export type ManagerTab = "api" | "local";

/** Sub-view of the API tab: configured profiles vs the preset template gallery. */
export type ApiView = "configured" | "templates";

interface ModelManagerModalProps {
  /** Preselect entries matching this capability (card "Manage…" entry point). */
  capability?: ModelCapability | null;
  onClose: () => void;
}

function emptyApiProfile(registry: BackendRegistry): ApiProfileEntry {
  return {
    ref: uniqueRef("api-profile", registry.apiProfiles),
    display_name: "",
    provider_kind: "openai-compatible",
    base_url: "",
    credentials_ref: "",
    default_model: "",
    known_models: [],
    capabilities: [],
    health: "untested",
  };
}

function CapabilityPicker({
  selected,
  onChange,
}: {
  selected: ModelCapability[];
  onChange: (caps: ModelCapability[]) => void;
}) {
  return (
    <div className="model-manager-caps">
      {MODEL_CAPABILITIES.map((cap) => (
        <label key={cap} className="snap-toggle">
          <input
            type="checkbox"
            checked={selected.includes(cap)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, cap] : selected.filter((c) => c !== cap),
              )
            }
          />
          {cap}
        </label>
      ))}
    </div>
  );
}

export function ModelManagerModal({ capability, onClose }: ModelManagerModalProps) {
  const t = useT();
  const [registry, setRegistry] = useState<BackendRegistry>(() => loadRegistry());
  const [tab, setTab] = useState<ManagerTab>("api");
  const [apiView, setApiView] = useState<ApiView>("configured");
  const [editingApi, setEditingApi] = useState<ApiProfileEntry | null>(null);
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const commit = useCallback((next: BackendRegistry) => {
    setRegistry(next);
    saveRegistry(next);
  }, []);

  // Manual connection test (shared with the Model/API agent actions): the
  // check itself lives in `backendHealth.ts`.
  const handleTestApi = useCallback(
    (profile: ApiProfileEntry) => {
      if (profile.base_url.trim()) setMessage(t("models.testing"));
      void testApiProfileHealth(profile).then(({ outcome, health }) => {
        commit(upsertApiProfile(loadRegistry(), { ...profile, health }));
        setMessage(
          outcome === "no_base_url"
            ? t("models.noBaseUrl")
            : outcome === "reachable"
              ? t("models.reachable")
              : t("models.unreachable"),
        );
      });
    },
    [commit, t],
  );

  // Manual local model test (shared with the Model/API agent actions): the
  // weights probe lives in `backendHealth.ts`.
  const handleTestLocal = useCallback(
    (model: LocalModelEntry) => {
      if (model.weights_path.trim()) setMessage(t("models.testing"));
      void probeLocalModelHealth(model).then(({ outcome, health, detail }) => {
        if (health !== null) {
          const nextDetail = outcome === "no_weights_path" ? t("models.noWeightsPath") : detail;
          commit(
            upsertLocalModel(loadRegistry(), { ...model, health, health_detail: nextDetail }),
          );
        }
        if (outcome === "desktop_only") setMessage(t("models.desktopOnlyTest"));
        else if (outcome === "weights_found") setMessage(t("models.weightsFound"));
        else if (outcome === "weights_missing") setMessage(t("models.weightsMissing"));
        else if (outcome === "probe_error") setMessage(detail ?? "");
      });
    },
    [commit, t],
  );

  const apiProfiles = useMemo(
    () =>
      [...registry.apiProfiles].sort((a, b) => a.ref.localeCompare(b.ref)),
    [registry.apiProfiles],
  );
  const localModels = useMemo(
    () =>
      [...registry.localModels].sort((a, b) => a.ref.localeCompare(b.ref)),
    [registry.localModels],
  );

  const matchesCapability = useCallback(
    (caps: ModelCapability[]) => !capability || caps.includes(capability),
    [capability],
  );

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className="media-viewer model-manager" onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          <span className="media-viewer-name">
            {t("models.title")}
            {capability ? <span className="muted"> · {capability}</span> : null}
          </span>
          <div className="media-viewer-actions">
            <button className={tab === "api" ? "active" : ""} onClick={() => setTab("api")}>
              {t("models.tabApi")}
            </button>
            <button className={tab === "local" ? "active" : ""} onClick={() => setTab("local")}>
              {t("models.tabLocal")}
            </button>
            <button onClick={onClose} title={t("models.closeTitle")}>
              ✕
            </button>
          </div>
        </div>

        <div className="model-manager-body">
          {tab === "api" ? (
            <>
              <div className="model-manager-list-actions model-manager-api-views">
                <button
                  className={apiView === "configured" ? "active" : ""}
                  onClick={() => setApiView("configured")}
                >
                  {t("models.apiViewConfigured")}
                </button>
                <button
                  className={apiView === "templates" ? "active" : ""}
                  onClick={() => setApiView("templates")}
                >
                  {t("models.apiViewTemplates")}
                </button>
              </div>
              {apiView === "templates" ? (
                <div className="model-manager-presets">
                  <span className="muted">{t("models.presetsTitle")}</span>
                  <div className="model-manager-preset-cards">
                    {API_PROFILE_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setEditingApi(profileFromPreset(preset, registry))}
                      >
                        <span className="model-manager-preset-icon">
                          <PresetProviderIcon presetId={preset.id} />
                        </span>
                        <span className="model-manager-preset-text">
                          <strong>{preset.display_name}</strong>
                          <span className="muted">{preset.provider_kind}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <span className="muted">{t("models.presetsHint")}</span>
                </div>
              ) : (
              <>
              <div className="model-manager-list-actions">
                <button
                  className="primary"
                  onClick={() => setEditingApi(emptyApiProfile(registry))}
                >
                  {t("models.addProfile")}
                </button>
                <span className="muted">{message}</span>
              </div>
              {apiProfiles.length === 0 && (
                <p className="muted">{t("models.emptyApi")}</p>
              )}
              <ul className="model-manager-list">
                {apiProfiles.map((p) => (
                  <li
                    key={p.ref}
                    className={matchesCapability(p.capabilities) ? "" : "model-manager-dim"}
                  >
                    <div className="model-manager-entry">
                      <strong>{p.display_name || p.ref}</strong>
                      <code>{p.ref}</code>
                      <span className="muted">
                        {p.provider_kind}
                        {p.default_model ? ` · ${p.default_model}` : ""}
                        {p.capabilities.length ? ` · ${p.capabilities.join(", ")}` : ""}
                      </span>
                      <span className={`model-manager-health health-${p.health}`}>
                        {t(`models.health.${p.health}` as MsgKey)}
                      </span>
                    </div>
                    <div className="model-manager-entry-actions">
                      <button onClick={() => handleTestApi(p)}>{t("models.test")}</button>
                      <button onClick={() => setEditingApi(p)}>{t("models.edit")}</button>
                      <button onClick={() => commit(duplicateApiProfile(registry, p.ref))}>
                        {t("models.duplicate")}
                      </button>
                      <button onClick={() => commit(removeApiProfile(registry, p.ref))}>
                        {t("models.remove")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              </>
              )}
              {editingApi && (
                <form
                  className="model-manager-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    commit(upsertApiProfile(registry, editingApi));
                    setEditingApi(null);
                    setApiView("configured");
                  }}
                >
                  <div className="model-manager-form-grid">
                  <label className="field">
                    <span>{t("models.ref")}</span>
                    <input
                      value={editingApi.ref}
                      onChange={(e) => setEditingApi({ ...editingApi, ref: e.target.value })}
                      required
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.displayName")}</span>
                    <input
                      value={editingApi.display_name}
                      onChange={(e) =>
                        setEditingApi({ ...editingApi, display_name: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.providerKind")}</span>
                    <input
                      value={editingApi.provider_kind}
                      onChange={(e) =>
                        setEditingApi({ ...editingApi, provider_kind: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.baseUrl")}</span>
                    <input
                      value={editingApi.base_url}
                      onChange={(e) => setEditingApi({ ...editingApi, base_url: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.credentialsRef")}</span>
                    <input
                      value={editingApi.credentials_ref}
                      onChange={(e) =>
                        setEditingApi({ ...editingApi, credentials_ref: e.target.value })
                      }
                      placeholder={t("models.credentialsRefHint")}
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.defaultModel")}</span>
                    <input
                      value={editingApi.default_model}
                      onChange={(e) =>
                        setEditingApi({ ...editingApi, default_model: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.knownModels")}</span>
                    <input
                      value={editingApi.known_models.join(", ")}
                      onChange={(e) =>
                        setEditingApi({
                          ...editingApi,
                          known_models: e.target.value
                            .split(",")
                            .map((m) => m.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder={t("models.knownModelsHint")}
                    />
                  </label>
                  </div>
                  <span className="muted">{t("models.capabilities")}</span>
                  <CapabilityPicker
                    selected={editingApi.capabilities}
                    onChange={(caps) => setEditingApi({ ...editingApi, capabilities: caps })}
                  />
                  <div className="model-manager-form-actions">
                    <button type="submit" className="primary">
                      {t("models.save")}
                    </button>
                    <button type="button" onClick={() => setEditingApi(null)}>
                      {t("models.cancel")}
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : (
            <>
              <div className="model-manager-list-actions">
                <span className="muted">{message}</span>
              </div>
              {localModels.length === 0 && (
                <p className="muted">{t("models.emptyLocal")}</p>
              )}
              <ul className="model-manager-list">
                {localModels.map((m) => (
                  <li
                    key={m.ref}
                    className={matchesCapability(m.capabilities) ? "" : "model-manager-dim"}
                  >
                    <div className="model-manager-entry">
                      <strong>{m.display_name || m.ref}</strong>
                      <code>{m.ref}</code>
                      <span className="muted">
                        {m.engine}
                        {m.capabilities.length ? ` · ${m.capabilities.join(", ")}` : ""}
                        {` · ${m.device_policy}/${m.precision_policy}`}
                      </span>
                      <span className={`model-manager-health health-${m.health}`}>
                        {t(`models.health.${m.health}` as MsgKey)}
                        {m.health_detail ? ` — ${m.health_detail}` : ""}
                      </span>
                    </div>
                    <div className="model-manager-entry-actions">
                      <button onClick={() => handleTestLocal(m)}>{t("models.test")}</button>
                      <button onClick={() => commit(removeLocalModel(registry, m.ref))}>
                        {t("models.remove")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
