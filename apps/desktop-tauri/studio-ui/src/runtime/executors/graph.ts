import type { ExecutorRegistry } from "../dag";

/** Non-empty, trimmed lines of a batch node's `items` param. */
export function batchItems(items: unknown): string[] {
  return String(items ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const GRAPH_EXECUTORS = {
  // Emits a single item from the list. A normal run emits index 0; batch
  // fan-out sweeps `index` via runGraph's paramOverrides.
  batch: async (ctx) => {
    const items = batchItems(ctx.params.items);
    const index = Number(ctx.params.index ?? 0);
    return { item: items[index] ?? items[0] ?? "" };
  },
  imageSource: async (ctx) => ({ image: String(ctx.params.path ?? "") || null }),
  videoSource: async (ctx) => ({ video: String(ctx.params.path ?? "") || null }),
  psdTemplate: async (ctx) => ({ template: String(ctx.params.path ?? "") || null }),
  number: async (ctx) => ({ value: Number(ctx.params.value ?? 0) }),
  // Pass-through relay: forwards whatever arrives on `in` to `out` unchanged.
  reroute: async (ctx) => ({ out: ctx.inputs.in ?? null }),
  // Group container is purely organisational: no ports, no work at run time.
  group: async () => ({}),
  // Comparison source: emits 1/0 from comparing two values. Numeric comparison
  // when both sides parse as numbers, else lexicographic string comparison.
  compare: async (ctx) => {
    const a = ctx.inputs.a;
    const b = ctx.inputs.b;
    const an = Number(a);
    const bn = Number(b);
    const numeric =
      a !== "" && a != null && b !== "" && b != null && !Number.isNaN(an) && !Number.isNaN(bn);
    const sa = String(a ?? "");
    const sb = String(b ?? "");
    const op = String(ctx.params.op ?? "==");
    let res: boolean;
    switch (op) {
      case "==":
        res = numeric ? an === bn : sa === sb;
        break;
      case "!=":
        res = numeric ? an !== bn : sa !== sb;
        break;
      case ">":
        res = numeric ? an > bn : sa > sb;
        break;
      case ">=":
        res = numeric ? an >= bn : sa >= sb;
        break;
      case "<":
        res = numeric ? an < bn : sa < sb;
        break;
      case "<=":
        res = numeric ? an <= bn : sa <= sb;
        break;
      default:
        res = false;
    }
    return { result: res ? 1 : 0 };
  },
  // Boolean logic source: emits 1/0 from the truthiness of its inputs. `not`
  // negates only `a`.
  logic: async (ctx) => {
    const a = !!ctx.inputs.a;
    const b = !!ctx.inputs.b;
    const op = String(ctx.params.op ?? "and");
    let res: boolean;
    switch (op) {
      case "and":
        res = a && b;
        break;
      case "or":
        res = a || b;
        break;
      case "xor":
        res = a !== b;
        break;
      case "not":
        res = !a;
        break;
      default:
        res = false;
    }
    return { result: res ? 1 : 0 };
  },
  // Conditional gate. Emits `value` on exactly one output port; the other port
  // gets nothing, which prunes that branch (its subtree is skipped). The wired
  // `cond` input (truthiness) wins over the param fallback.
  if: async (ctx) => {
    const active =
      "cond" in ctx.inputs ? !!ctx.inputs.cond : String(ctx.params.cond ?? "true") === "true";
    const value = ctx.inputs.value ?? null;
    return active ? { true: value } : { false: value };
  },
  // Multi-way router. Emits `value` on the port matching `index` (0/1/2), else
  // on `default`; all other ports stay empty so their branches are pruned.
  switch: async (ctx) => {
    const idx = "index" in ctx.inputs ? Number(ctx.inputs.index) : Number(ctx.params.index ?? 0);
    const port = idx === 0 ? "0" : idx === 1 ? "1" : idx === 2 ? "2" : "default";
    return { [port]: ctx.inputs.value ?? null };
  },
} satisfies ExecutorRegistry;
