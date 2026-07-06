// Software-level Prompt Assistant state (PROMPT_ASSISTANT_SYSTEM_PLAN): the
// conversation lives outside the workflow graph — pure helpers + localStorage
// persistence, kept out of the component for testing. The first version's
// "backend" is the local rule-based rewriter shared with the `promptOptimize`
// card's `local` mode; API profiles and local text models join through the
// global managers in later steps.

import { optimizePromptLocally, type LocalPreset } from "../runtime/promptOptimize";

export interface PromptAssistantMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface PromptAssistantSession {
  messages: PromptAssistantMessage[];
  preset: LocalPreset;
}

const SESSION_KEY = "hgripe.studio.promptAssistant.session.v1";
const OPEN_KEY = "hgripe.studio.promptAssistant.open.v1";

const PRESETS: LocalPreset[] = [
  "cleanup",
  "photographic",
  "anime",
  "cinematic",
  "detailed",
];

export function isLocalPreset(v: unknown): v is LocalPreset {
  return typeof v === "string" && (PRESETS as string[]).includes(v);
}

export function emptyAssistantSession(): PromptAssistantSession {
  return { messages: [], preset: "cleanup" };
}

/** Rewrite the user's idea into a prompt draft with the local rewriter. */
export function assistantReply(input: string, preset: LocalPreset): string {
  return optimizePromptLocally(input, preset);
}

/** The current draft is the latest assistant message, if any. */
export function latestDraft(session: PromptAssistantSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "assistant") return m.text;
  }
  return "";
}

/** Append a user turn plus the assistant's rewrite; empty input is a no-op. */
export function sendAssistantMessage(
  session: PromptAssistantSession,
  input: string,
  now: number = Date.now(),
): PromptAssistantSession {
  const text = input.trim();
  if (!text) return session;
  return {
    ...session,
    messages: [
      ...session.messages,
      { role: "user", text, at: now },
      { role: "assistant", text: assistantReply(text, session.preset), at: now },
    ],
  };
}

export function loadAssistantSession(): PromptAssistantSession {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return emptyAssistantSession();
    const parsed = JSON.parse(raw) as Partial<PromptAssistantSession>;
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.filter(
          (m): m is PromptAssistantMessage =>
            !!m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.text === "string" &&
            typeof m.at === "number",
        )
      : [];
    const preset = isLocalPreset(parsed.preset) ? parsed.preset : "cleanup";
    return { messages, preset };
  } catch {
    return emptyAssistantSession();
  }
}

export function saveAssistantSession(session: PromptAssistantSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* persistence is best-effort */
  }
}

export function loadAssistantOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAssistantOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* persistence is best-effort */
  }
}
