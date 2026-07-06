import { useEffect, useRef, useState } from "react";

import { useT } from "../i18n";
import type { LocalPreset } from "../runtime/promptOptimize";
import {
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
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    saveAssistantSession(session);
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [session]);

  const draft = latestDraft(session);

  const send = () => {
    const next = sendAssistantMessage(session, input);
    if (next === session) return;
    setSession(next);
    setInput("");
  };

  return (
    <div className="assistant-panel" role="dialog" aria-label={t("assistant.title")}>
      <div className="assistant-head">
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
      <div className="assistant-log" ref={logRef}>
        {session.messages.length === 0 && (
          <p className="assistant-empty">{t("assistant.empty")}</p>
        )}
        {session.messages.map((m, i) => (
          <div key={i} className={`assistant-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
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
        <button onClick={send} disabled={!input.trim()}>
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
          onClick={() => setSession((s) => ({ ...emptyAssistantSession(), preset: s.preset }))}
          disabled={session.messages.length === 0}
        >
          {t("assistant.clear")}
        </button>
      </div>
    </div>
  );
}
