// Software-level Prompt Assistant state (PROMPT_ASSISTANT_SYSTEM_PLAN): the
// conversation lives outside the workflow graph — pure helpers + localStorage
// persistence, kept out of the component for testing. Backends are the
// deterministic built-in rewriter or a managed `prompt.rewrite` API profile.
// Sessions that reference a retired backend are discarded instead of being
// silently redirected to another executor.

import { runTaskJson } from "../bridge/run";
import type { ApiProfileEntry } from "../models/backendRegistry";
import {
  optimizePromptLocally,
  promptOptimizeProviderSupported,
  type LocalPreset,
} from "../runtime/promptOptimize";

export interface PromptAssistantMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
}

/** Which rewriter answers the conversation. Only the managed ref is stored. */
export type AssistantBackend =
  | { kind: "built_in" }
  | { kind: "api_profile"; ref: string };

export interface PromptAssistantSession {
  messages: PromptAssistantMessage[];
  preset: LocalPreset;
  backend: AssistantBackend;
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

function sanitizeBackend(raw: unknown): AssistantBackend | null {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.kind === "api_profile" && typeof o.ref === "string" && o.ref)
      return { kind: "api_profile", ref: o.ref };
    if (o.kind === "built_in" || o.kind === "local") return { kind: "built_in" };
    if (o.kind === "local_model") return null;
  }
  return { kind: "built_in" };
}

export function emptyAssistantSession(): PromptAssistantSession {
  return { messages: [], preset: "cleanup", backend: { kind: "built_in" } };
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

/** Append one turn to the transcript. */
export function appendTurn(
  session: PromptAssistantSession,
  role: PromptAssistantMessage["role"],
  text: string,
  now: number = Date.now(),
): PromptAssistantSession {
  return {
    ...session,
    messages: [...session.messages, { role, text, at: now }],
  };
}

/** Append a user turn plus the assistant's local rewrite; empty input is a no-op. */
export function sendAssistantMessage(
  session: PromptAssistantSession,
  input: string,
  now: number = Date.now(),
): PromptAssistantSession {
  if (session.backend.kind !== "built_in") return session;
  const text = input.trim();
  if (!text) return session;
  return appendTurn(
    appendTurn(session, "user", text, now),
    "assistant",
    assistantReply(text, session.preset),
    now,
  );
}

/**
 * Rewrite the user's idea through a managed `prompt.rewrite` API profile
 * (same broker task shape as the `promptOptimize` card's `api` mode). Throws
 * with a readable message on unsupported providers or failed runs; the panel
 * surfaces that as an assistant turn instead of touching the graph.
 */
export async function assistantApiReply(
  input: string,
  profile: ApiProfileEntry,
): Promise<string> {
  const provider = profile.provider_kind || "openai_compatible";
  if (!promptOptimizeProviderSupported(provider)) {
    throw new Error(
      `Provider "${provider}" can't rewrite prompts (no text.generate support).`,
    );
  }
  const params: Record<string, unknown> = {};
  if (profile.default_model) params.model = profile.default_model;
  const task = {
    id: `assistant-${Date.now()}`,
    provider,
    operation: "text.generate",
    inputs: { prompt: input },
    params,
    credentials_ref: profile.credentials_ref || null,
    output_type: "text",
    cache_policy: { enabled: true, ttl_seconds: null, key: null },
    retry_policy: { max_attempts: 1, backoff_ms: 200, timeout_ms: 60000 },
  };
  const result = await runTaskJson(task);
  if (result.status === "failed") {
    throw new Error(result.error?.message ?? "prompt rewrite failed");
  }
  const rewritten = (result.output_json as { text?: unknown } | null)?.text;
  const text = typeof rewritten === "string" ? rewritten.trim() : "";
  return text || input;
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
    const backend = sanitizeBackend(parsed.backend);
    return backend ? { messages, preset, backend } : emptyAssistantSession();
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
