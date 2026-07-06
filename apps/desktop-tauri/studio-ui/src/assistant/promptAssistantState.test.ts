// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  emptyAssistantSession,
  latestDraft,
  loadAssistantOpen,
  loadAssistantSession,
  saveAssistantOpen,
  saveAssistantSession,
  sendAssistantMessage,
} from "./promptAssistantState";

beforeEach(() => localStorage.clear());

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

  it("round-trips the open flag, defaulting to closed", () => {
    expect(loadAssistantOpen()).toBe(false);
    saveAssistantOpen(true);
    expect(loadAssistantOpen()).toBe(true);
    saveAssistantOpen(false);
    expect(loadAssistantOpen()).toBe(false);
  });
});
