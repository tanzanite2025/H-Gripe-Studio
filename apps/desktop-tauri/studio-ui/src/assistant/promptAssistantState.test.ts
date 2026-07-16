// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiProfileEntry } from "../models/backendRegistry";
import {
  assistantApiReply,
  emptyAssistantSession,
  latestDraft,
  loadAssistantOpen,
  loadAssistantSession,
  saveAssistantOpen,
  saveAssistantSession,
  sendAssistantMessage,
} from "./promptAssistantState";

vi.mock("../bridge/run", () => ({ runTaskJson: vi.fn() }));
import { runTaskJson } from "../bridge/run";
const runTaskJsonMock = vi.mocked(runTaskJson);

function profile(overrides: Partial<ApiProfileEntry> = {}): ApiProfileEntry {
  return {
    ref: "openai-main",
    display_name: "OpenAI main",
    provider_kind: "openai_compatible",
    base_url: "https://api.example.test",
    credentials_ref: "cred-1",
    default_model: "gpt-test",
    known_models: ["gpt-test"],
    capabilities: ["prompt.rewrite"],
    health: "valid",
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  runTaskJsonMock.mockReset();
});

describe("sendAssistantMessage", () => {
  it("appends a user turn and a rewritten assistant draft", () => {
    const s = sendAssistantMessage(emptyAssistantSession(), "a fox,  a fox, forest", 42);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toEqual({ role: "user", text: "a fox,  a fox, forest", at: 42 });
    expect(s.messages[1].role).toBe("assistant");
    expect(s.messages[1].text).toBe("a fox, forest");
    expect(latestDraft(s)).toBe("a fox, forest");
  });

  it("applies the session preset's booster tags", () => {
    const s = sendAssistantMessage(
      { ...emptyAssistantSession(), preset: "cinematic" },
      "a fox",
    );
    expect(latestDraft(s)).toBe(
      "a fox, cinematic lighting, dramatic composition, depth of field, film grain",
    );
  });

  it("ignores blank input", () => {
    const s = emptyAssistantSession();
    expect(sendAssistantMessage(s, "   ")).toBe(s);
    expect(latestDraft(s)).toBe("");
  });
});

describe("persistence", () => {
  it("round-trips the session and drops malformed entries", () => {
    const s = sendAssistantMessage(emptyAssistantSession(), "a fox", 1);
    saveAssistantSession({ ...s, preset: "anime" });
    const loaded = loadAssistantSession();
    expect(loaded.messages).toEqual(s.messages);
    expect(loaded.preset).toBe("anime");

    localStorage.setItem(
      "hgripe.studio.promptAssistant.session.v1",
      JSON.stringify({ messages: [{ role: "bogus", text: 1 }], preset: "nope" }),
    );
    expect(loadAssistantSession()).toEqual(emptyAssistantSession());
  });

  it("defaults to a fresh session on unreadable storage", () => {
    localStorage.setItem("hgripe.studio.promptAssistant.session.v1", "{not json");
    expect(loadAssistantSession()).toEqual(emptyAssistantSession());
  });

  it("drops a retired local-model session instead of silently changing its backend", () => {
    localStorage.setItem(
      "hgripe.studio.promptAssistant.session.v1",
      JSON.stringify({
        messages: [{ role: "user", text: "old prompt", at: 1 }],
        preset: "anime",
        backend: { kind: "local_model", ref: "old" },
      }),
    );
    expect(loadAssistantSession()).toEqual(emptyAssistantSession());
  });

  it("round-trips the API backend ref and drops malformed backends", () => {
    saveAssistantSession({
      ...emptyAssistantSession(),
      backend: { kind: "api_profile", ref: "openai-main" },
    });
    expect(loadAssistantSession().backend).toEqual({
      kind: "api_profile",
      ref: "openai-main",
    });

    localStorage.setItem(
      "hgripe.studio.promptAssistant.session.v1",
      JSON.stringify({ messages: [], preset: "cleanup", backend: { kind: "api_profile" } }),
    );
    expect(loadAssistantSession().backend).toEqual({ kind: "built_in" });
  });

  it("round-trips the open flag, defaulting to closed", () => {
    expect(loadAssistantOpen()).toBe(false);
    saveAssistantOpen(true);
    expect(loadAssistantOpen()).toBe(true);
    saveAssistantOpen(false);
    expect(loadAssistantOpen()).toBe(false);
  });
});

describe("assistantApiReply", () => {
  it("runs a text.generate broker task shaped like the promptOptimize api mode", async () => {
    runTaskJsonMock.mockResolvedValue({
      id: "t",
      status: "succeeded",
      output_json: { text: " a refined fox prompt " },
    });
    await expect(assistantApiReply("a fox", profile())).resolves.toBe(
      "a refined fox prompt",
    );
    const task = runTaskJsonMock.mock.calls[0][0] as Record<string, unknown>;
    expect(task.provider).toBe("openai_compatible");
    expect(task.operation).toBe("text.generate");
    expect(task.inputs).toEqual({ prompt: "a fox" });
    expect(task.params).toEqual({ model: "gpt-test" });
    expect(task.credentials_ref).toBe("cred-1");
  });

  it("falls back to the input when the provider returns no text", async () => {
    runTaskJsonMock.mockResolvedValue({ id: "t", status: "succeeded", output_json: {} });
    await expect(assistantApiReply("a fox", profile())).resolves.toBe("a fox");
  });

  it("throws on failed runs and unsupported providers", async () => {
    runTaskJsonMock.mockResolvedValue({
      id: "t",
      status: "failed",
      error: { message: "rate limited" },
    });
    await expect(assistantApiReply("a fox", profile())).rejects.toThrow("rate limited");

    await expect(
      assistantApiReply("a fox", profile({ provider_kind: "replicate" })),
    ).rejects.toThrow(/can't rewrite prompts/);
    expect(runTaskJsonMock).toHaveBeenCalledTimes(1);
  });
});
