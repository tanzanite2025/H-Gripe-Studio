import { port, type NodeSpec } from "./types";

export const WORKFLOW_NODE_SPECS = {
  batch: {
    kind: "batch",
    family: "utility",
    executor: "graph",
    title: "Batch",
    description:
      "Sweeps a list of text items (one per line). A normal Run emits the first item; use \"Run ×N\" to fan out one run per item.",
    category: "workflow",
    inputs: [],
    outputs: [port("item", "item", "text")],
    params: [
      {
        key: "items",
        label: "Items (one per line)",
        control: "textarea",
        defaultValue: "",
        hint: "one prompt / value per line",
        inline: true,
      },
    ],
  },
} satisfies Record<string, NodeSpec>;
