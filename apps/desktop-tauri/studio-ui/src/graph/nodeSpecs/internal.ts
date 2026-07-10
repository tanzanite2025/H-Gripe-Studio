import { port, type NodeSpec } from "./types";

export const INTERNAL_NODE_SPECS = {
  number: {
    kind: "number",
    family: "utility",
    executor: "graph",
    palette: "internal",
    title: "Number",
    description: "A numeric value (seed, count, …) fed into other nodes.",
    category: "internal",
    inputs: [],
    outputs: [port("value", "value", "number")],
    params: [
      { key: "value", label: "Value", control: "number", defaultValue: 0, inline: true },
    ],
  },
  compare: {
    kind: "compare",
    family: "utility",
    executor: "graph",
    palette: "internal",
    title: "Compare",
    description:
      "Compares two values and emits 1 (true) or 0 (false). Numeric when both sides parse as numbers, else string comparison. Wire `result` into an If's `cond`.",
    category: "internal",
    inputs: [port("a", "a", "any"), port("b", "b", "any")],
    outputs: [port("result", "result", "number")],
    params: [
      {
        key: "op",
        label: "Operator",
        control: "select",
        options: ["==", "!=", ">", ">=", "<", "<="],
        defaultValue: "==",
        inline: true,
      },
    ],
  },
  logic: {
    kind: "logic",
    family: "utility",
    executor: "graph",
    palette: "internal",
    title: "Logic",
    description:
      "Boolean logic on the truthiness of its inputs, emitting 1 (true) or 0 (false). `not` uses only `a`. Wire `result` into an If's `cond`.",
    category: "internal",
    inputs: [port("a", "a", "any"), port("b", "b", "any")],
    outputs: [port("result", "result", "number")],
    params: [
      {
        key: "op",
        label: "Operator",
        control: "select",
        options: ["and", "or", "xor", "not"],
        defaultValue: "and",
        inline: true,
      },
    ],
  },
  if: {
    kind: "if",
    family: "utility",
    executor: "graph",
    palette: "internal",
    title: "If",
    description:
      "Conditional gate: forwards `value` to the `true` or `false` output based on a condition. The branch that is not taken is pruned (its downstream nodes are skipped).",
    category: "internal",
    inputs: [port("value", "value", "any"), port("cond", "cond", "any")],
    outputs: [port("true", "true", "any"), port("false", "false", "any")],
    params: [
      {
        key: "cond",
        label: "Condition (when no input wired)",
        control: "select",
        options: ["true", "false"],
        defaultValue: "true",
        hint: "If a `cond` input is connected, its truthiness wins.",
        inline: true,
      },
    ],
  },
  switch: {
    kind: "switch",
    family: "utility",
    executor: "graph",
    palette: "internal",
    title: "Switch",
    description:
      "Multi-way router: forwards `value` to the output matching `index` (0/1/2), else to `default`. Unselected branches are pruned (skipped).",
    category: "internal",
    inputs: [port("value", "value", "any"), port("index", "index", "number")],
    outputs: [
      port("0", "0", "any"),
      port("1", "1", "any"),
      port("2", "2", "any"),
      port("default", "default", "any"),
    ],
    params: [
      {
        key: "index",
        label: "Index (when no input wired)",
        control: "number",
        defaultValue: 0,
        min: 0,
        step: 1,
        inline: true,
      },
    ],
  },
  reroute: {
    kind: "reroute",
    family: "utility",
    executor: "graph",
    palette: "internal",
    title: "Reroute",
    description:
      "Pass-through relay: forwards its input unchanged. Use it to tidy long edges and route wires around the canvas.",
    category: "internal",
    inputs: [port("in", "in", "any")],
    outputs: [port("out", "out", "any")],
    params: [],
  },
} satisfies Record<string, NodeSpec>;
