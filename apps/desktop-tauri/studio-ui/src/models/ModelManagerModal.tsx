import { useCallback, useEffect, useMemo, useState } from "react";

import { tauriInvoke } from "../bridge/core";
import {
  deviceRegistrySnapshot,
  type DeviceRegistrySnapshot,
} from "../bridge/deviceRegistry";
import {
  lastEngineProbe,
  probeEnginesCached,
  type EngineProbeReport,
} from "../bridge/engineProbe";
import { listProfiles } from "../bridge/tauri";
import { useT, type MsgKey } from "../i18n";
import {
  summarizeCapabilities,
  summarizeDeviceRegistry,
} from "../runtime/capabilitySummary";
import {
  DEVICE_PREFERENCES,
  getDevicePreference,
  setDevicePreference,
  type DevicePreference,
} from "../runtime/devicePreference";
import {
  MODEL_CAPABILITIES,
  duplicateApiProfile,
  duplicateLocalModel,
  importLegacyProfiles,
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

// The system "Models / APIs" manager modal
// (docs/plans/active/SYSTEM_MODEL_MANAGER_SURFACE_PLAN.md): one global surface
// owning API profiles and local model bindings, so card-level dropdowns all
// read from the same registry. Probes are manual only — nothing here runs on
// app startup or when a dropdown opens.

export type ManagerTab = "api" | "local";

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

function emptyLocalModel(registry: BackendRegistry): LocalModelEntry {
  return {
    ref: uniqueRef("local-model", registry.localModels),
    display_name: "",
    capabilities: [],
    engine: "onnx",
    weights_path: "",
    device_policy: "auto",
    precision_policy: "auto",
    health: "untested",
    fallback_policy: "built_in",
    health_detail: null,
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
                e.target.checked
                  ? [...selected, cap]
                  : selected.filter((c) => c !== cap),
              )
            }
          />
          {cap}
        </label>
      ))}
    </div>
  );
}

export function ModelManagerModal({
  capability,
  onClose,
}: ModelManagerModalProps) {
  const t = useT();
  const [registry, setRegistry] = useState<BackendRegistry>(() =>
    loadRegistry(),
  );
  const [tab, setTab] = useState<ManagerTab>("api");
  const [editingApi, setEditingApi] = useState<ApiProfileEntry | null>(null);
  const [editingLocal, setEditingLocal] = useState<LocalModelEntry | null>(
    null,
  );
  const [message, setMessage] = useState<string>("");
  // Capability probe summary (diagnostics only, manual refresh; seeded from
  // the cached report so reopening the modal shows the last snapshot).
  const [probe, setProbe] = useState<EngineProbeReport | null>(() =>
    lastEngineProbe(),
  );
  // Central device registry snapshot (GPU_DEVICE_STRATEGY_PLAN step 13),
  // fetched alongside the engine probe on the same manual refresh.
  const [deviceRegistry, setDeviceRegistry] =
    useState<DeviceRegistrySnapshot | null>(null);
  const [probing, setProbing] = useState(false);
  // Global default device preference (GPU plan long-term step 5): only seeds
  // unset `device` params; explicit per-node choices always win.
  const [devicePreference, setDevicePreferenceState] =
    useState<DevicePreference>(() => getDevicePreference());

  const handleProbe = useCallback(() => {
    setProbing(true);
    Promise.all([probeEnginesCached(true), deviceRegistrySnapshot()])
      .then(([report, registrySnapshot]) => {
        setProbe(report);
        setDeviceRegistry(registrySnapshot);
      })
      .catch((err) => setMessage(String(err)))
      .finally(() => setProbing(false));
  }, []);

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

  // Manual seed from the legacy H-Gripe provider profiles (never automatic).
  const handleImportLegacy = useCallback(() => {
    void listProfiles()
      .then((profiles) => {
        commit(importLegacyProfiles(loadRegistry(), profiles));
        setMessage(t("models.imported"));
      })
      .catch((err) => setMessage(String(err)));
  }, [commit, t]);

  // Manual connection test: reachability of the profile's base URL. A raw key
  // is never involved here — credentials stay behind their secret ref.
  const handleTestApi = useCallback(
    (profile: ApiProfileEntry) => {
      const finish = (health: ApiProfileEntry["health"]) =>
        commit(upsertApiProfile(loadRegistry(), { ...profile, health }));
      if (!profile.base_url.trim()) {
        finish(profile.credentials_ref.trim() ? "untested" : "missing_key");
        setMessage(t("models.noBaseUrl"));
        return;
      }
      setMessage(t("models.testing"));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      fetch(profile.base_url, { method: "GET", signal: controller.signal })
        .then(() => {
          finish(profile.credentials_ref.trim() ? "valid" : "missing_key");
          setMessage(t("models.reachable"));
        })
        .catch(() => {
          finish("unreachable");
          setMessage(t("models.unreachable"));
        })
        .finally(() => clearTimeout(timer));
    },
    [commit, t],
  );

  // Manual local model test: weights presence via the backend (desktop only).
  const handleTestLocal = useCallback(
    (model: LocalModelEntry) => {
      const finish = (
        health: LocalModelEntry["health"],
        detail: string | null,
      ) =>
        commit(
          upsertLocalModel(loadRegistry(), {
            ...model,
            health,
            health_detail: detail,
          }),
        );
      if (!model.weights_path.trim()) {
        finish("missing_weights", t("models.noWeightsPath"));
        return;
      }
      const invoke = tauriInvoke();
      if (!invoke) {
        setMessage(t("models.desktopOnlyTest"));
        return;
      }
      setMessage(t("models.testing"));
      invoke("probe_model_weights", { path: model.weights_path })
        .then((present) => {
          if (present) finish("installed", null);
          else finish("missing_weights", model.weights_path);
          setMessage(
            present ? t("models.weightsFound") : t("models.weightsMissing"),
          );
        })
        .catch((err) => {
          finish("untested", String(err));
          setMessage(String(err));
        });
    },
    [commit, t],
  );

  const apiProfiles = useMemo(
    () => [...registry.apiProfiles].sort((a, b) => a.ref.localeCompare(b.ref)),
    [registry.apiProfiles],
  );
  const localModels = useMemo(
    () => [...registry.localModels].sort((a, b) => a.ref.localeCompare(b.ref)),
    [registry.localModels],
  );

  const matchesCapability = useCallback(
    (caps: ModelCapability[]) => !capability || caps.includes(capability),
    [capability],
  );

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div
        className="media-viewer model-manager"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="media-viewer-bar">
          <span className="media-viewer-name">
            {t("models.title")}
            {capability ? <span className="muted"> · {capability}</span> : null}
          </span>
          <div className="media-viewer-actions">
            <button
              className={tab === "api" ? "active" : ""}
              onClick={() => setTab("api")}
            >
              {t("models.tabApi")}
            </button>
            <button
              className={tab === "local" ? "active" : ""}
              onClick={() => setTab("local")}
            >
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
              <div className="model-manager-list-actions">
                <button
                  className="primary"
                  onClick={() => setEditingApi(emptyApiProfile(registry))}
                >
                  {t("models.addProfile")}
                </button>
                <button
                  onClick={handleImportLegacy}
                  title={t("models.importLegacyTitle")}
                >
                  {t("models.importLegacy")}
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
                    className={
                      matchesCapability(p.capabilities)
                        ? ""
                        : "model-manager-dim"
                    }
                  >
                    <div className="model-manager-entry">
                      <strong>{p.display_name || p.ref}</strong>
                      <code>{p.ref}</code>
                      <span className="muted">
                        {p.provider_kind}
                        {p.default_model ? ` · ${p.default_model}` : ""}
                        {p.capabilities.length
                          ? ` · ${p.capabilities.join(", ")}`
                          : ""}
                      </span>
                      <span
                        className={`model-manager-health health-${p.health}`}
                      >
                        {t(`models.health.${p.health}` as MsgKey)}
                      </span>
                    </div>
                    <div className="model-manager-entry-actions">
                      <button onClick={() => handleTestApi(p)}>
                        {t("models.test")}
                      </button>
                      <button onClick={() => setEditingApi(p)}>
                        {t("models.edit")}
                      </button>
                      <button
                        onClick={() =>
                          commit(duplicateApiProfile(registry, p.ref))
                        }
                      >
                        {t("models.duplicate")}
                      </button>
                      <button
                        onClick={() =>
                          commit(removeApiProfile(registry, p.ref))
                        }
                      >
                        {t("models.remove")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {editingApi && (
                <form
                  className="model-manager-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    commit(upsertApiProfile(registry, editingApi));
                    setEditingApi(null);
                  }}
                >
                  <label className="field">
                    <span>{t("models.ref")}</span>
                    <input
                      value={editingApi.ref}
                      onChange={(e) =>
                        setEditingApi({ ...editingApi, ref: e.target.value })
                      }
                      required
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.displayName")}</span>
                    <input
                      value={editingApi.display_name}
                      onChange={(e) =>
                        setEditingApi({
                          ...editingApi,
                          display_name: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.providerKind")}</span>
                    <input
                      value={editingApi.provider_kind}
                      onChange={(e) =>
                        setEditingApi({
                          ...editingApi,
                          provider_kind: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.baseUrl")}</span>
                    <input
                      value={editingApi.base_url}
                      onChange={(e) =>
                        setEditingApi({
                          ...editingApi,
                          base_url: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.credentialsRef")}</span>
                    <input
                      value={editingApi.credentials_ref}
                      onChange={(e) =>
                        setEditingApi({
                          ...editingApi,
                          credentials_ref: e.target.value,
                        })
                      }
                      placeholder={t("models.credentialsRefHint")}
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.defaultModel")}</span>
                    <input
                      value={editingApi.default_model}
                      onChange={(e) =>
                        setEditingApi({
                          ...editingApi,
                          default_model: e.target.value,
                        })
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
                  <span className="muted">{t("models.capabilities")}</span>
                  <CapabilityPicker
                    selected={editingApi.capabilities}
                    onChange={(caps) =>
                      setEditingApi({ ...editingApi, capabilities: caps })
                    }
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
                <button
                  className="primary"
                  onClick={() => setEditingLocal(emptyLocalModel(registry))}
                >
                  {t("models.addModel")}
                </button>
                <span className="muted">{message}</span>
              </div>
              {localModels.length === 0 && (
                <p className="muted">{t("models.emptyLocal")}</p>
              )}
              <div className="model-manager-capability">
                <div className="model-manager-list-actions">
                  <span className="muted">
                    {t("models.devicePreferenceTitle")}
                  </span>
                  <select
                    value={devicePreference}
                    onChange={(e) => {
                      const next = e.target.value as DevicePreference;
                      setDevicePreference(next);
                      setDevicePreferenceState(next);
                    }}
                  >
                    {DEVICE_PREFERENCES.map((pref) => (
                      <option key={pref} value={pref}>
                        {t(`models.devicePreference.${pref}` as MsgKey)}
                      </option>
                    ))}
                  </select>
                  <span className="muted">
                    {t("models.devicePreferenceHint")}
                  </span>
                </div>
                <div className="model-manager-list-actions">
                  <span className="muted">{t("models.capabilityTitle")}</span>
                  <button onClick={handleProbe} disabled={probing}>
                    {probing ? t("models.probing") : t("models.probeEngines")}
                  </button>
                </div>
                {probe ? (
                  <ul className="model-manager-capability-lines">
                    {summarizeCapabilities(probe).map((line) => (
                      <li
                        key={line.label}
                        className={line.tone === "warn" ? "warn" : ""}
                      >
                        <code>{line.label}</code>
                        <span className="muted"> · {line.value}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t("models.capabilityHint")}</p>
                )}
                {deviceRegistry && (
                  <>
                    <span className="muted">
                      {t("models.deviceRegistryTitle")}
                    </span>
                    <ul className="model-manager-capability-lines">
                      {summarizeDeviceRegistry(deviceRegistry).map(
                        (line, i) => (
                          <li
                            key={`${line.label}-${i}`}
                            className={line.tone === "warn" ? "warn" : ""}
                          >
                            <code>{line.label}</code>
                            <span className="muted"> · {line.value}</span>
                          </li>
                        ),
                      )}
                    </ul>
                  </>
                )}
              </div>
              <ul className="model-manager-list">
                {localModels.map((m) => (
                  <li
                    key={m.ref}
                    className={
                      matchesCapability(m.capabilities)
                        ? ""
                        : "model-manager-dim"
                    }
                  >
                    <div className="model-manager-entry">
                      <strong>{m.display_name || m.ref}</strong>
                      <code>{m.ref}</code>
                      <span className="muted">
                        {m.engine}
                        {m.capabilities.length
                          ? ` · ${m.capabilities.join(", ")}`
                          : ""}
                        {` · ${m.device_policy}/${m.precision_policy}`}
                      </span>
                      <span
                        className={`model-manager-health health-${m.health}`}
                      >
                        {t(`models.health.${m.health}` as MsgKey)}
                        {m.health_detail ? ` — ${m.health_detail}` : ""}
                      </span>
                    </div>
                    <div className="model-manager-entry-actions">
                      <button onClick={() => handleTestLocal(m)}>
                        {t("models.test")}
                      </button>
                      <button onClick={() => setEditingLocal(m)}>
                        {t("models.edit")}
                      </button>
                      <button
                        onClick={() =>
                          commit(duplicateLocalModel(registry, m.ref))
                        }
                      >
                        {t("models.duplicate")}
                      </button>
                      <button
                        onClick={() =>
                          commit(removeLocalModel(registry, m.ref))
                        }
                      >
                        {t("models.remove")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {editingLocal && (
                <form
                  className="model-manager-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    commit(upsertLocalModel(registry, editingLocal));
                    setEditingLocal(null);
                  }}
                >
                  <label className="field">
                    <span>{t("models.ref")}</span>
                    <input
                      value={editingLocal.ref}
                      onChange={(e) =>
                        setEditingLocal({
                          ...editingLocal,
                          ref: e.target.value,
                        })
                      }
                      required
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.displayName")}</span>
                    <input
                      value={editingLocal.display_name}
                      onChange={(e) =>
                        setEditingLocal({
                          ...editingLocal,
                          display_name: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.engine")}</span>
                    <input
                      value={editingLocal.engine}
                      onChange={(e) =>
                        setEditingLocal({
                          ...editingLocal,
                          engine: e.target.value,
                        })
                      }
                      placeholder="onnx / ort / native / external"
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.weightsPath")}</span>
                    <input
                      value={editingLocal.weights_path}
                      onChange={(e) =>
                        setEditingLocal({
                          ...editingLocal,
                          weights_path: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{t("models.devicePolicy")}</span>
                    <select
                      value={editingLocal.device_policy}
                      onChange={(e) =>
                        setEditingLocal({
                          ...editingLocal,
                          device_policy: e.target
                            .value as LocalModelEntry["device_policy"],
                        })
                      }
                    >
                      <option value="auto">auto</option>
                      <option value="cpu">cpu</option>
                      <option value="cuda">cuda</option>
                      <option value="directml">directml</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("models.precisionPolicy")}</span>
                    <select
                      value={editingLocal.precision_policy}
                      onChange={(e) =>
                        setEditingLocal({
                          ...editingLocal,
                          precision_policy: e.target
                            .value as LocalModelEntry["precision_policy"],
                        })
                      }
                    >
                      <option value="auto">auto</option>
                      <option value="fp32">fp32</option>
                      <option value="fp16">fp16</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("models.fallbackPolicy")}</span>
                    <select
                      value={editingLocal.fallback_policy}
                      onChange={(e) =>
                        setEditingLocal({
                          ...editingLocal,
                          fallback_policy: e.target
                            .value as LocalModelEntry["fallback_policy"],
                        })
                      }
                    >
                      <option value="built_in">built-in</option>
                      <option value="cpu">cpu</option>
                      <option value="api">api</option>
                      <option value="none">none</option>
                    </select>
                  </label>
                  <span className="muted">{t("models.capabilities")}</span>
                  <CapabilityPicker
                    selected={editingLocal.capabilities}
                    onChange={(caps) =>
                      setEditingLocal({ ...editingLocal, capabilities: caps })
                    }
                  />
                  <div className="model-manager-form-actions">
                    <button type="submit" className="primary">
                      {t("models.save")}
                    </button>
                    <button type="button" onClick={() => setEditingLocal(null)}>
                      {t("models.cancel")}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
