import { useCallback, useEffect, useMemo, useState } from "react";

import { useT, type MsgKey } from "../i18n";
import {
  MODEL_CAPABILITIES,
  duplicateApiProfile,
  loadRegistry,
  removeApiProfile,
  saveRegistry,
  uniqueRef,
  upsertApiProfile,
  type ApiProfileEntry,
  type BackendRegistry,
  type ModelCapability,
} from "./backendRegistry";
import { testApiProfileHealth } from "./backendHealth";
import { API_PROFILE_PRESETS, profileFromPreset } from "./apiProfilePresets";
import { PresetProviderIcon } from "./providerIcons";

/** Sub-view of the API profile manager. */
export type ApiView = "configured" | "templates";

interface ModelManagerModalProps {
  /** Dim profiles that do not advertise the requested capability. */
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
              onChange(e.target.checked ? [...selected, cap] : selected.filter((c) => c !== cap))
            }
          />
          {cap}
        </label>
      ))}
    </div>
  );
}

/** API-only profile manager. */
export function ModelManagerModal({ capability, onClose }: ModelManagerModalProps) {
  const t = useT();
  const [registry, setRegistry] = useState<BackendRegistry>(() => loadRegistry());
  const [apiView, setApiView] = useState<ApiView>("configured");
  const [editingApi, setEditingApi] = useState<ApiProfileEntry | null>(null);
  const [message, setMessage] = useState("");

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

  const apiProfiles = useMemo(
    () => [...registry.apiProfiles].sort((a, b) => a.ref.localeCompare(b.ref)),
    [registry.apiProfiles],
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
            {capability ? <span className="muted"> - {capability}</span> : null}
          </span>
          <div className="media-viewer-actions">
            <button onClick={onClose} title={t("models.closeTitle")} aria-label={t("models.closeTitle")}>
              X
            </button>
          </div>
        </div>

        <div className="model-manager-body">
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
                <button className="primary" onClick={() => setEditingApi(emptyApiProfile(registry))}>
                  {t("models.addProfile")}
                </button>
                <span className="muted">{message}</span>
              </div>
              {apiProfiles.length === 0 && <p className="muted">{t("models.emptyApi")}</p>}
              <ul className="model-manager-list">
                {apiProfiles.map((profile) => (
                  <li
                    key={profile.ref}
                    className={matchesCapability(profile.capabilities) ? "" : "model-manager-dim"}
                  >
                    <div className="model-manager-entry">
                      <strong>{profile.display_name || profile.ref}</strong>
                      <code>{profile.ref}</code>
                      <span className="muted">
                        {profile.provider_kind}
                        {profile.default_model ? ` - ${profile.default_model}` : ""}
                        {profile.capabilities.length ? ` - ${profile.capabilities.join(", ")}` : ""}
                      </span>
                      <span className={`model-manager-health health-${profile.health}`}>
                        {t(`models.health.${profile.health}` as MsgKey)}
                      </span>
                    </div>
                    <div className="model-manager-entry-actions">
                      <button onClick={() => handleTestApi(profile)}>{t("models.test")}</button>
                      <button onClick={() => setEditingApi(profile)}>{t("models.edit")}</button>
                      <button onClick={() => commit(duplicateApiProfile(registry, profile.ref))}>
                        {t("models.duplicate")}
                      </button>
                      <button onClick={() => commit(removeApiProfile(registry, profile.ref))}>
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
                    onChange={(e) => setEditingApi({ ...editingApi, display_name: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t("models.providerKind")}</span>
                  <input
                    value={editingApi.provider_kind}
                    onChange={(e) => setEditingApi({ ...editingApi, provider_kind: e.target.value })}
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
                    onChange={(e) => setEditingApi({ ...editingApi, credentials_ref: e.target.value })}
                    placeholder={t("models.credentialsRefHint")}
                  />
                </label>
                <label className="field">
                  <span>{t("models.defaultModel")}</span>
                  <input
                    value={editingApi.default_model}
                    onChange={(e) => setEditingApi({ ...editingApi, default_model: e.target.value })}
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
                          .map((model) => model.trim())
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
                onChange={(capabilities) => setEditingApi({ ...editingApi, capabilities })}
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
        </div>
      </div>
    </div>
  );
}
