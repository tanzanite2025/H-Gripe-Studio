// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptAssistantPanel } from "./PromptAssistantPanel";

vi.mock("../bridge/run", () => ({ runTaskJson: vi.fn() }));
import { runTaskJson } from "../bridge/run";
const runTaskJsonMock = vi.mocked(runTaskJson);

function seedRegistry(): void {
  localStorage.setItem(
    "hgripe.studio.modelRegistry.v1",
    JSON.stringify({
      apiProfiles: [
        {
          ref: "openai-main",
          display_name: "OpenAI main",
          provider_kind: "openai_compatible",
          base_url: "",
          credentials_ref: "cred-1",
          default_model: "gpt-test",
          known_models: [],
          capabilities: ["prompt.rewrite"],
          health: "valid",
        },
      ],
      localModels: [
        {
          ref: "qwen-mini",
          display_name: "Qwen mini",
          capabilities: ["prompt.rewrite"],
          engine: "ort",
          weights_path: "",
          device_policy: "auto",
          precision_policy: "auto",
          health: "installed",
          fallback_policy: "built_in",
        },
      ],
    }),
  );
}

function panelProps(overrides: Partial<Parameters<typeof PromptAssistantPanel>[0]> = {}) {
  return {
    insertTargetTitle: null,
    onInsertIntoSelected: () => {},
    onCreatePromptNode: () => {},
    onClose: () => {},
    ...overrides,
  };
}

function sendMessage(container: HTMLElement, text: string): void {
  const textarea = container.querySelector<HTMLTextAreaElement>(".assistant-input textarea");
  expect(textarea).toBeDefined();
  fireEvent.change(textarea!, { target: { value: text } });
  fireEvent.keyDown(textarea!, { key: "Enter" });
}

function actionButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".assistant-actions button"),
  ).find((el) => el.textContent === label);
  expect(btn).toBeDefined();
  return btn!;
}

beforeEach(() => {
  localStorage.clear();
  runTaskJsonMock.mockReset();
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("PromptAssistantPanel", () => {
  it("drafts a rewritten prompt from a sent message", () => {
    const { container } = render(<PromptAssistantPanel {...panelProps()} />);
    sendMessage(container, "a fox, a fox, forest");
    const msgs = container.querySelectorAll(".assistant-msg");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].textContent).toBe("a fox, a fox, forest");
    expect(msgs[1].textContent).toBe("a fox, forest");
  });

  it("disables insert without a selected Prompt card and enables it with one", () => {
    const onInsert = vi.fn();
    const { container, rerender } = render(
      <PromptAssistantPanel {...panelProps({ onInsertIntoSelected: onInsert })} />,
    );
    sendMessage(container, "a fox");
    expect(actionButton(container, "Insert into selected card").disabled).toBe(true);

    rerender(
      <PromptAssistantPanel
        {...panelProps({ insertTargetTitle: "promptOptimize-1", onInsertIntoSelected: onInsert })}
      />,
    );
    const insert = actionButton(container, "Insert into selected card");
    expect(insert.disabled).toBe(false);
    fireEvent.click(insert);
    expect(onInsert).toHaveBeenCalledWith("a fox");
  });

  it("creates a Prompt card from the latest draft", () => {
    const onCreate = vi.fn();
    const { container } = render(
      <PromptAssistantPanel {...panelProps({ onCreatePromptNode: onCreate })} />,
    );
    expect(actionButton(container, "Create Prompt card").disabled).toBe(true);
    sendMessage(container, "a fox");
    fireEvent.click(actionButton(container, "Create Prompt card"));
    expect(onCreate).toHaveBeenCalledWith("a fox");
  });

  it("clears the session but keeps the preset", () => {
    const { container } = render(<PromptAssistantPanel {...panelProps()} />);
    const preset = container.querySelectorAll<HTMLSelectElement>(".assistant-backend select")[1]!;
    fireEvent.change(preset, { target: { value: "anime" } });
    sendMessage(container, "a fox");
    fireEvent.click(actionButton(container, "Clear session"));
    expect(container.querySelectorAll(".assistant-msg")).toHaveLength(0);
    expect(preset.value).toBe("anime");
  });

  it("lists manager prompt.rewrite profiles and answers through the API backend", async () => {
    seedRegistry();
    runTaskJsonMock.mockResolvedValue({
      id: "t",
      status: "succeeded",
      output_json: { text: "a majestic fox, golden hour" },
    });
    const { container } = render(<PromptAssistantPanel {...panelProps()} />);
    const backend = container.querySelector<HTMLSelectElement>(".assistant-backend select")!;
    fireEvent.change(backend, { target: { value: "api:openai-main" } });
    // The built-in preset row hides while an API profile is selected.
    expect(container.querySelectorAll(".assistant-backend select")).toHaveLength(1);
    sendMessage(container, "a fox");
    await waitFor(() => {
      const msgs = container.querySelectorAll(".assistant-msg");
      expect(msgs).toHaveLength(2);
      expect(msgs[1].textContent).toBe("a majestic fox, golden hour");
    });
    expect(runTaskJsonMock).toHaveBeenCalledTimes(1);
  });

  it("does not offer legacy local models from the registry", () => {
    seedRegistry();
    const { container } = render(<PromptAssistantPanel {...panelProps()} />);
    const backend = container.querySelector<HTMLSelectElement>(".assistant-backend select")!;
    expect(Array.from(backend.options).some((option) => option.value.includes("qwen-mini"))).toBe(false);
  });

  it("drops a persisted local-model session before allowing a new built-in turn", () => {
    seedRegistry();
    localStorage.setItem(
      "hgripe.studio.promptAssistant.session.v1",
      JSON.stringify({
        messages: [],
        preset: "cleanup",
        backend: { kind: "local_model", ref: "qwen-mini" },
      }),
    );
    const { container } = render(<PromptAssistantPanel {...panelProps()} />);
    const backend = container.querySelector<HTMLSelectElement>(".assistant-backend select")!;
    expect(backend.value).toBe("builtin");
    sendMessage(container, "a fox");
    const msgs = container.querySelectorAll(".assistant-msg");
    expect(msgs).toHaveLength(2);
    expect(msgs[1].textContent).toBe("a fox");
    expect(runTaskJsonMock).not.toHaveBeenCalled();
  });

  it("surfaces API failures as an assistant turn", async () => {
    seedRegistry();
    runTaskJsonMock.mockResolvedValue({
      id: "t",
      status: "failed",
      error: { message: "rate limited" },
    });
    const { container } = render(<PromptAssistantPanel {...panelProps()} />);
    const backend = container.querySelector<HTMLSelectElement>(".assistant-backend select")!;
    fireEvent.change(backend, { target: { value: "api:openai-main" } });
    sendMessage(container, "a fox");
    await waitFor(() => {
      const msgs = container.querySelectorAll(".assistant-msg");
      expect(msgs).toHaveLength(2);
      expect(msgs[1].textContent).toContain("rate limited");
    });
  });
});
