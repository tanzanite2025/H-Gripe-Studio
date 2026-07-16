import {
  compositeRepaint,
  getOutputDir,
  prepareRepaintRegions,
  runTaskJson,
} from "../../bridge/tauri";
import type { RepaintedCrop } from "../../bridge/tauri";
import { type QualityReport } from "../../contracts/quality";
import {
  optimizePromptLocally,
  promptOptimizeProviderSupported,
  type LocalPreset,
} from "../promptOptimize";
import type { ExecutorRegistry } from "../dag";

// Params that are not forwarded into the broker task's `params` map; they are
// top-level task fields instead.
const GENERATE_RESERVED = new Set(["provider", "operation", "credentials_ref"]);

// Detail Repaint params consumed by the node itself / forwarded as top-level
// task fields, so they are not copied into each region's broker task `params`.
const DETAIL_REPAINT_RESERVED = new Set([
  "provider",
  "operation",
  "credentials_ref",
  "engine",
  "precision",
  "controlnet",
  "repaint_prompt_base",
  "repaint_actions",
  "min_confidence",
  "region_padding",
  "max_regions",
  "feather_px",
  "blend",
  "output_dir",
  "output_name",
]);

export const API_EXECUTORS = {
  // Initial text node with optional prompt optimisation. A connected `text`
  // input overrides the param. `off` passes through, `builtin` applies the
  // model-free preset transform, `api` rewrites via an LLM provider profile.
  promptOptimize: async (ctx) => {
    const raw =
      "text" in ctx.inputs
        ? String(ctx.inputs.text ?? "")
        : String(ctx.params.text ?? "");
    const mode = String(ctx.params.mode ?? "off");

    if (mode === "builtin" || mode === "local") {
      const preset = String(ctx.params.preset ?? "cleanup") as LocalPreset;
      return { text: optimizePromptLocally(raw, preset) };
    }

    if (mode === "api") {
      if (!raw.trim()) return { text: raw };
      const provider = String(ctx.params.provider ?? "openai_compatible") || "openai_compatible";
      if (!promptOptimizeProviderSupported(provider)) {
        throw new Error(
          `Provider "${provider}" can't optimize prompts (no text.generate support). ` +
            `Pick an OpenAI-compatible chat profile, or switch mode to "builtin"/"off".`,
        );
      }
      const params: Record<string, unknown> = {};
      const model = String(ctx.params.model ?? "").trim();
      if (model) params.model = model;
      const instruction = String(ctx.params.instruction ?? "").trim();
      if (instruction) params.system_prompt = instruction;
      // Optional sampling controls (forwarded to the chat call when set).
      for (const key of ["temperature", "max_tokens", "seed"] as const) {
        const num = Number(ctx.params[key]);
        if (ctx.params[key] !== undefined && ctx.params[key] !== "" && Number.isFinite(num)) {
          params[key] = num;
        }
      }

      const task = {
        id: `studio-${ctx.nodeId}-${Date.now()}`,
        provider,
        operation: "text.generate",
        inputs: { prompt: raw },
        params,
        credentials_ref: String(ctx.params.credentials_ref ?? "") || null,
        output_type: "text",
        // Cache identical optimisations (same text+instruction+model+sampling)
        // so re-runs don't re-bill the LLM; the broker derives the key.
        cache_policy: { enabled: true, ttl_seconds: null, key: null },
        retry_policy: { max_attempts: 1, backoff_ms: 200, timeout_ms: 60000 },
      };

      const result = await runTaskJson(task);
      if (result.status === "failed") {
        throw new Error(result.error?.message ?? "prompt optimization failed");
      }
      const optimized = (result.output_json as { text?: unknown } | null)?.text;
      const text = typeof optimized === "string" ? optimized.trim() : "";
      return { text: text || raw, result };
    }

    return { text: raw };
  },
  generate: async (ctx) => {
    const prompt = (ctx.inputs.prompt as string | undefined) ?? "";
    const reference = ctx.inputs.reference as string | undefined;
    const seedInput = ctx.inputs.seed as number | undefined;

    const inputs: Record<string, unknown> = {};
    if (prompt) inputs.prompt = prompt;
    if (reference) inputs.image_path = reference;

    // Forward every non-reserved, non-empty param into the broker task params.
    // A connected `seed` input overrides the param of the same name.
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ctx.params)) {
      if (GENERATE_RESERVED.has(key)) continue;
      if (value === "" || value === null || value === undefined) continue;
      params[key] = value;
    }
    if (seedInput !== undefined) params.seed = seedInput;

    const credentialsRef = String(ctx.params.credentials_ref ?? "") || null;
    const task = {
      id: `studio-${ctx.nodeId}-${Date.now()}`,
      provider: String(ctx.params.provider ?? "mock"),
      operation: String(ctx.params.operation ?? "image.generate"),
      inputs,
      params,
      credentials_ref: credentialsRef,
      output_type: "image",
      cache_policy: { enabled: false, ttl_seconds: null, key: null },
      retry_policy: { max_attempts: 1, backoff_ms: 200, timeout_ms: 60000 },
    };

    const result = await runTaskJson(task);
    if (result.status === "failed") {
      throw new Error(result.error?.message ?? "generation failed");
    }
    const image = result.output_files?.[0]?.path;
    return { image: image ?? null, result };
  },
  // Localized issue-region repaint built on a Detail Watchdog QualityReport.
  // Crops each repaintable issue + writes an inpaint mask (`prepareRepaintRegions`),
  // sends each crop + mask + repaint prompt through the broker's `image.edit`
  // (same provider/credentials path as `generate`), then pastes the results back
  // with a feathered seam (`compositeRepaint`). With no edit-capable provider
  // (empty / `mock`) the broker loop is skipped and the image passes through.
  detailRepaint: async (ctx) => {
    const image = (ctx.inputs.image as string | undefined) ?? null;
    if (!image) throw new Error("Detail Repaint needs a connected image input");
    const retiredRef = String(ctx.params.local_model_ref ?? "").trim();
    const requestedEngine = String(ctx.params.engine ?? "provider").trim() || "provider";
    if (retiredRef || requestedEngine !== "provider") {
      throw new Error(
        `local repaint backend ${retiredRef || requestedEngine} is retired and unavailable; choose an API profile`,
      );
    }

    const outputDir = String(ctx.params.output_dir ?? "").trim() || (await getOutputDir());
    const prepared = await prepareRepaintRegions({
      image,
      qualityReport: (ctx.inputs.quality_report as QualityReport | undefined) ?? undefined,
      repaintActions: String(ctx.params.repaint_actions ?? "").trim() || undefined,
      minConfidence: Number(ctx.params.min_confidence ?? 0),
      padding: Number(ctx.params.region_padding ?? 24),
      maxRegions: Number(ctx.params.max_regions ?? 8),
      outputDir: outputDir || undefined,
      outputName: String(ctx.params.output_name ?? "").trim() || undefined,
    });

    const provider = String(ctx.params.provider ?? "mock");
    const operation = String(ctx.params.operation ?? "image.edit");
    const credentialsRef = String(ctx.params.credentials_ref ?? "") || null;
    const promptBase = String(ctx.params.repaint_prompt_base ?? "").trim();

    const regionPrompt = (issue: string) =>
      promptBase
        ? issue
          ? `${promptBase} (issue: ${issue})`
          : promptBase
        : `Repaint and restore this ${issue || "flagged"} region with clean, realistic detail; keep the style, lighting and colours consistent with the surroundings.`;

    const repainted: RepaintedCrop[] = [];

    // Forward every non-reserved, non-empty param into each region's task.
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ctx.params)) {
      if (DETAIL_REPAINT_RESERVED.has(key)) continue;
      if (value === "" || value === null || value === undefined) continue;
      params[key] = value;
    }

    // mock / empty provider has no `image.edit` capability: leave every region
    // unrepainted so the composite step passes the image through unchanged.
    const providerCanEdit = provider.length > 0 && provider !== "mock";
    if (providerCanEdit) {
      for (const region of prepared.regions) {
        const issue = region.type ?? "";
        const prompt = regionPrompt(issue);
        const task = {
          id: `studio-${ctx.nodeId}-r${region.index}-${Date.now()}`,
          provider,
          operation,
          inputs: { image_path: region.crop_path, mask_path: region.mask_path, prompt },
          params: { ...params, save_outputs: true },
          credentials_ref: credentialsRef,
          output_type: "image",
          cache_policy: { enabled: false, ttl_seconds: null, key: null },
          retry_policy: { max_attempts: 1, backoff_ms: 200, timeout_ms: 120000 },
        };
        const result = await runTaskJson(task);
        // A per-region provider failure leaves that region unrepainted rather
        // than aborting the whole node.
        if (result.status !== "failed") {
          const path = result.output_files?.[0]?.path;
          if (path) repainted.push({ index: region.index, path });
        }
      }
    }

    const composed = await compositeRepaint({
      image,
      manifest: prepared,
      repainted,
      featherPx: Number(ctx.params.feather_px ?? 0),
      blend: String(ctx.params.blend ?? "").trim() || undefined,
      outputDir: outputDir || undefined,
      outputName: String(ctx.params.output_name ?? "").trim() || undefined,
    });
    return {
      fixed_image: composed.fixed_image,
      repaint_report: composed.repaint_report,
    };
  },
} satisfies ExecutorRegistry;
