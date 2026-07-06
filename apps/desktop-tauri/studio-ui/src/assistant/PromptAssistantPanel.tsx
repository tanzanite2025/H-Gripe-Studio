import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import {
  REGISTRY_EVENT,
  apiProfilesFor,
  loadRegistry,
  localModelsFor,
} from "../models/backendRegistry";
import { ModelManagerModal } from "../models/ModelManagerModal";
import type { LocalPreset } from "../runtime/promptOptimize";
import {
  appendTurn,
  assistantApiReply,
  emptyAssistantSession,
  latestDraft,
  loadAssistantSession,
  saveAssistantSession,
  sendAssistantMessage,
} from "./promptAssistantState";

const PRESET_OPTIONS: LocalPreset[] = [
  "cleanup",
  "photographic",
  "anime",
  "cinematic",
  "detailed",
];

interface PromptAssistantPanelProps {
  /** Title of the selected Prompt card, when one is selected on the canvas. */
  insertTargetTitle: string | null;
  onInsertIntoSelected: (text: string) => void;
  onCreatePromptNode: (text: string) => void;
  onClose: () => void;
}

// Docked right panel: multi-turn drafting against the local rule-based
// rewriter, with explicit insert actions — the graph only receives the text
// the user inserts (the transcript never joins the DAG). Session state
// persists in localStorage, separate from workflow persistence.
export function PromptAssistantPanel({
  insertTargetTitle,
  onInsertIntoSelected,
  onCreatePromptNode,
  onClose,
}: PromptAssistantPanelProps) {
  const t = useT();
  const [session, setSession] = useState(loadAssistantSession);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  // Reloaded on every registry save so manager edits show up live.
  const [registry, setRegistry] = useState(() => loadRegistry());
  useEffect(() => {
    const reload = () => setRegistry(loadRegistry());
    window.addEventListener(REGISTRY_EVENT, reload);
    return () => window.removeEventListener(REGISTRY_EVENT, reload);
  }, []);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    saveAssistantSession(session);
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [session]);

  const draft = latestDraft(session);

  // Global manager options for the assistant backend (plan steps 4-5: the
  // same capability-filtered selector API every card uses; the session keeps
  // only the managed ref).
  const apiOptions = apiProfilesFor(registry, "prompt.rewrite");
  const localOptions = localModelsFor(registry, "prompt.rewrite");
  const backend = session.backend;
  const backendValue =
    backend.kind === "api_profile"
      ? `api:${backend.ref}`
      : backend.kind === "local_model"
        ? `localModel:${backend.ref}`
        : "local";
  const backendDangling =
    (backend.kind === "api_profile" && !apiOptions.some((p) => p.ref === backend.ref)) ||
    (backend.kind === "local_model" && !localOptions.some((m) => m.ref === backend.ref));

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    // Managed local text models draft through the built-in rewriter until the
    // local text engine lands (same behaviour as the Prompt card's local model
    // selection); a real inference path replaces this reply in a later step.
    if (session.backend.kind !== "api_profile") {
      const next = sendAssistantMessage(session, input);
      if (next === session) return;
      setSession(next);
      setInput("");
      return;
    }
    const ref = session.backend.ref;
    const profile = apiOptions.find((p) => p.ref === ref);
    const asked = appendTurn(session, "user", text);
    setSession(asked);
    setInput("");
    if (!profile) {
      setSession(appendTurn(asked, "assistant", t("assistant.backendGone", { ref })));
      return;
    }
    setBusy(true);
    assistantApiReply(text, profile)
      .then((reply) => setSession((s) => appendTurn(s, "assistant", reply)))
      .catch((err: unknown) =>
        setSession((s) =>
          appendTurn(s, "assistant", t("assistant.apiError", { error: String(err) })),
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="assistant-panel" role="dialog" aria-label={t("assistant.title")}>
      <div className="assistant-head" data-drag-handle>
        <h2>{t("assistant.title")}</h2>
        <span className="spacer" />
        <button
          className="assistant-close"
          onClick={onClose}
          title={t("assistant.close")}
          aria-label={t("assistant.close")}
        >
          ×
        </button>
      </div>
      <div className="assistant-backend">
        <span>{t("assistant.backend")}</span>
        <select
          value={backendDangling ? "" : backendValue}
          onChange={(e) => {
            const v = e.target.value;
            setSession((s) => ({
              ...s,
              backend: v.startsWith("api:")
                ? { kind: "api_profile", ref: v.slice("api:".length) }
                : v.startsWith("localModel:")
                  ? { kind: "local_model", ref: v.slice("localModel:".length) }
                  : { kind: "local" },
            }));
          }}
          aria-label={t("assistant.backend")}
        >
          {backendDangling && <option value="">{backend.ref}</option>}
          <option value="local">{t("assistant.backendLocal")}</option>
          {localOptions.length > 0 && (
            <optgroup label={t("models.selector.groupLocal")}>
              {localOptions.map((m) => (
                <option key={m.ref} value={`localModel:${m.ref}`}>
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
        <button type="button" onClick={() => setManagerOpen(true)}>
          {t("models.selector.manage")}
        </button>
      </div>
      {session.backend.kind === "local_model" && !backendDangling && (
        <div className="assistant-backend">
          <span className="assistant-note">{t("assistant.localModelNote")}</span>
        </div>
      )}
      {session.backend.kind !== "api_profile" && (
        <div className="assistant-backend">
          <span>{t("assistant.preset")}</span>
          <select
            value={session.preset}
            onChange={(e) =>
              setSession((s) => ({ ...s, preset: e.target.value as LocalPreset }))
            }
            aria-label={t("assistant.preset")}
          >
            {PRESET_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="assistant-log" ref={logRef}>
        {session.messages.length === 0 && (
          <p className="assistant-empty">{t("assistant.empty")}</p>
        )}
        {session.messages.map((m, i) => (
          <div key={i} className={`assistant-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <p className="assistant-empty">{t("assistant.waiting")}</p>}
      </div>
      <div className="assistant-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t("assistant.placeholder")}
          rows={2}
        />
        <button onClick={send} disabled={!input.trim() || busy}>
          {t("assistant.send")}
        </button>
      </div>
      <div className="assistant-actions">
        <button
          onClick={() => onInsertIntoSelected(draft)}
          disabled={!draft || !insertTargetTitle}
          title={insertTargetTitle ?? undefined}
        >
          {t("assistant.insert")}
        </button>
        <button onClick={() => onCreatePromptNode(draft)} disabled={!draft}>
          {t("assistant.create")}
        </button>
        <button
          onClick={() => void navigator.clipboard?.writeText(draft)}
          disabled={!draft}
        >
          {t("assistant.copy")}
        </button>
        <span className="spacer" />
        <button
          onClick={() =>
            setSession((s) => ({ ...emptyAssistantSession(), preset: s.preset, backend: s.backend }))
          }
          disabled={session.messages.length === 0}
        >
          {t("assistant.clear")}
        </button>
      </div>
      {managerOpen &&
        createPortal(
          <ModelManagerModal
            capability="prompt.rewrite"
            onClose={() => {
              setManagerOpen(false);
              setRegistry(loadRegistry());
            }}
          />,
          document.body,
        )}
    </div>
  );
}
