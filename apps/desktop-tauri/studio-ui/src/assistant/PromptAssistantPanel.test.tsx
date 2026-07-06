// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptAssistantPanel } from "./PromptAssistantPanel";

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

beforeEach(() => localStorage.clear());
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
    expect(actionButton(container, "Insert into selected Prompt").disabled).toBe(true);

    rerender(
      <PromptAssistantPanel
        {...panelProps({ insertTargetTitle: "promptOptimize-1", onInsertIntoSelected: onInsert })}
      />,
    );
    const insert = actionButton(container, "Insert into selected Prompt");
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
    const preset = container.querySelector<HTMLSelectElement>(".assistant-backend select")!;
    fireEvent.change(preset, { target: { value: "anime" } });
    sendMessage(container, "a fox");
    fireEvent.click(actionButton(container, "Clear session"));
    expect(container.querySelectorAll(".assistant-msg")).toHaveLength(0);
    expect(preset.value).toBe("anime");
  });
});
