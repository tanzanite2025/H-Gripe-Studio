// Target-aware assistant insertion (PROMPT_ASSISTANT_SYSTEM_PLAN step 7):
// which selected cards accept a prompt draft, and how a Generate card
// receives one. Pure graph-shape helpers so App wiring stays testable.

/** Cards whose `text` param takes the draft directly. */
export function isPromptTextTarget(kind: string): boolean {
  return kind === "promptOptimize";
}

/** Cards the assistant's Insert action can target. */
export function isAssistantInsertTarget(kind: string): boolean {
  return isPromptTextTarget(kind) || kind === "generate";
}

export interface InsertEdge {
  source: string;
  target: string;
  targetHandle?: string | null;
}

/**
 * How a draft lands on a selected Generate card: update the Prompt card
 * already feeding its `prompt` input, wire in a fresh Prompt card when the
 * input is free, or refuse when a non-prompt node owns the input.
 */
export type GenerateInsertPlan =
  | { action: "update_upstream"; nodeId: string }
  | { action: "wire_new" }
  | { action: "blocked"; nodeId: string };

export function planGenerateInsert(
  targetId: string,
  edges: readonly InsertEdge[],
  kindOf: (id: string) => string | null,
): GenerateInsertPlan {
  const edge = edges.find((e) => e.target === targetId && e.targetHandle === "prompt");
  if (!edge) return { action: "wire_new" };
  const kind = kindOf(edge.source);
  return kind !== null && isPromptTextTarget(kind)
    ? { action: "update_upstream", nodeId: edge.source }
    : { action: "blocked", nodeId: edge.source };
}
