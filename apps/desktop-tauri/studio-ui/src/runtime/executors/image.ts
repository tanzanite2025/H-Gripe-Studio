import {
  analyzePsdContext,
  composePsd,
  detectQualityIssues,
  enhanceImage,
  getOutputDir,
  matchLightColor,
  refineMaskEdge,
} from "../../bridge/tauri";
import { type Bounds, type VisualContext } from "../../contracts/context";
import {
  findLayer,
  layeredAssetManifest,
  stubLayeredImageAsset,
  STUB_ORIGINAL_LAYER_ID,
  type LayeredImageAsset,
} from "../../domain/layeredImage";
import type { ExecutorRegistry } from "../dag";

export const IMAGE_EXECUTORS = {
  // Browser-preview fallback: wraps the connected image into the stub
  // LayeredImageAsset (locked original layer + background/subject candidates
  // with placeholder masks). The desktop runtime runs real segmentation on the
  // compute lane instead (studio/layer_split.rs); the ports are identical.
  smartLayerSplit: async (ctx) => {
    const image = (ctx.inputs.image as string | undefined) ?? null;
    const video = (ctx.inputs.video as string | undefined) ?? null;
    if (!image && video) {
      throw new Error("video frame splitting runs in the desktop runtime only");
    }
    if (!image) throw new Error("Smart Layer Split needs a connected image or video input");
    const asset = stubLayeredImageAsset({ imagePath: image, nodeId: ctx.nodeId });
    const selectedKind = String(ctx.params.selected_kind ?? "subject");
    const selected =
      selectedKind === "original"
        ? findLayer(asset, STUB_ORIGINAL_LAYER_ID)
        : asset.layers.find((layer) => layer.kind === selectedKind) ?? null;
    return {
      layered_asset: asset,
      composite_preview: asset.preview_composite.path,
      selected_layer: selected?.rgba?.path ?? asset.base_image.path,
      masks: asset.layers.map((layer) => ({ layer_id: layer.id, mask: layer.mask.path })),
      split_report: asset.split_report,
    };
  },
  // Crops the connected image. The real work runs in native Rust on the
  // Compute lane (`run_studio_graph`); browser preview has no backend to
  // rasterise against, so it passes the source path through as the result and
  // leaves the report null. See docs/cards/generic-media-card.md.
  crop: async (ctx) => {
    const image = (ctx.inputs.image as string | undefined) ?? null;
    if (!image) throw new Error("Crop needs a connected image input");
    return { image, crop_report: null };
  },
  save: async (ctx) => ({
    image: ctx.inputs.image ?? null,
    template: ctx.inputs.template ?? null,
    filename: String(ctx.params.filename ?? "output.png"),
  }),
  // Reads a PSD template (connected `template` input, else the `psd_path`
  // param) into a structured VisualContext via the backend
  // `analyze_psd_context` command, exposing the context plus its flat output
  // ports (prompt suffix, background preview, placeholder mask + bounds) for
  // downstream production nodes.
  psdContextAnalyze: async (ctx) => {
    const template =
      (ctx.inputs.template as string | undefined) ??
      (String(ctx.params.psd_path ?? "").trim() || null);
    if (!template) {
      throw new Error(
        "PSD Context Analyze needs a PSD template (connect a PSD Template node or set psd_path)",
      );
    }

    const outputDir = String(ctx.params.output_dir ?? "").trim() || (await getOutputDir());
    const references = String(ctx.params.reference_layers ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const context = await analyzePsdContext({
      template,
      backgroundLayer: String(ctx.params.background_layer ?? "").trim() || undefined,
      targetPlaceholder: String(ctx.params.target_placeholder ?? "").trim() || undefined,
      referenceLayers: references.length > 0 ? references : undefined,
      outputDir: outputDir || undefined,
    });
    return {
      visual_context: context,
      prompt_suffix: context.prompt_suffix,
      background_image: context.background.image_path,
      placeholder_mask: context.placeholder.mask_path,
      placeholder_bounds: context.placeholder.bounds,
    };
  },
  // Nudges the upstream subject image's light & colour toward the PSD
  // background (Reinhard Lab transfer / histogram match, sparing brand colours)
  // via the backend `match_light_color` command, exposing the matched image,
  // the match report, and a prompt suffix.
  matchLightColor: async (ctx) => {
    const image = (ctx.inputs.image as string | undefined) ?? null;
    if (!image) throw new Error("Light & Color Match needs a connected image input");

    const outputDir = String(ctx.params.output_dir ?? "").trim() || (await getOutputDir());
    const result = await matchLightColor({
      image,
      background: (ctx.inputs.background as string | undefined) || undefined,
      mask: (ctx.inputs.mask as string | undefined) || undefined,
      context: (ctx.inputs.visual_context as VisualContext | undefined) ?? undefined,
      mode: String(ctx.params.mode ?? "color_transfer") || undefined,
      strength: Number(ctx.params.strength ?? 0.6),
      shadowStrength: Number(ctx.params.shadow_strength ?? 0),
      highlightStrength: Number(ctx.params.highlight_strength ?? 0),
      protectSaturation: Boolean(ctx.params.protect_saturation ?? false),
      protectBrandColor: Boolean(ctx.params.protect_brand_color ?? true),
      outputDir: outputDir || undefined,
      outputName: String(ctx.params.output_name ?? "").trim() || undefined,
    });
    return {
      matched_image: result.matched_image,
      match_report: result.match_report,
      prompt_suffix: result.prompt_suffix,
    };
  },
  // Cleans the upstream subject's matte (erode/dilate, guided-filter edge
  // snapping, feather, colour decontamination) so it drops into a PSD
  // placeholder without white halos via the backend `refine_mask_edge`
  // command, exposing the refined image, refined mask, and an edge report.
  refineMaskEdge: async (ctx) => {
    const image = (ctx.inputs.image as string | undefined) ?? null;
    if (!image) throw new Error("Mask Edge Refine needs a connected image input");

    const outputDir = String(ctx.params.output_dir ?? "").trim() || (await getOutputDir());
    const result = await refineMaskEdge({
      image,
      mask: (ctx.inputs.mask as string | undefined) || undefined,
      background: (ctx.inputs.background as string | undefined) || undefined,
      placeholderMask: (ctx.inputs.placeholder_mask as string | undefined) || undefined,
      trimap: (ctx.inputs.trimap as string | undefined) || undefined,
      preset: String(ctx.params.preset ?? "natural") || undefined,
      erodePx: Number(ctx.params.erode_px ?? 1),
      dilatePx: Number(ctx.params.dilate_px ?? 0),
      featherPx: Number(ctx.params.feather_px ?? 4),
      guidedRadius: Number(ctx.params.guided_radius ?? 8),
      edgeDecontaminate: Boolean(ctx.params.edge_decontaminate ?? true),
      backgroundBlendStrength: Number(ctx.params.background_blend_strength ?? 0.4),
      outputDir: outputDir || undefined,
      outputName: String(ctx.params.output_name ?? "").trim() || undefined,
    });
    return {
      refined_image: result.refined_image,
      refined_mask: result.refined_mask,
      edge_report: result.edge_report,
    };
  },
  // Upscales the upstream subject to a PSD placeholder's pixel target through
  // the native `enhance_image` command using deterministic built-in processing.
  imageEnhance: async (ctx) => {
    const image = (ctx.inputs.image as string | undefined) ?? null;
    if (!image) throw new Error("Image Enhance needs a connected image input");

    const outputDir = String(ctx.params.output_dir ?? "").trim() || (await getOutputDir());
    const result = await enhanceImage({
      image,
      targetBounds: (ctx.inputs.target_bounds as Bounds | undefined) || undefined,
      mode: String(ctx.params.mode ?? "conservative") || undefined,
      targetWidth: Number(ctx.params.target_width ?? 0),
      targetHeight: Number(ctx.params.target_height ?? 0),
      maxPixels: Number(ctx.params.max_pixels ?? 48_000_000),
      scale: Number(ctx.params.scale ?? 2),
      denoiseStrength: Number(ctx.params.denoise_strength ?? 0.3),
      textureStrength: Number(ctx.params.texture_strength ?? 0.25),
      preserveTextLogo: Boolean(ctx.params.preserve_text_logo ?? true),
      outputDir: outputDir || undefined,
      outputName: String(ctx.params.output_name ?? "").trim() || undefined,
    });
    return {
      enhanced_image: result.enhanced_image,
      scale_factor: result.scale_factor,
      enhance_report: result.enhance_report,
    };
  },
  // Scans the upstream candidate image for local breakdowns (blur, alpha-rim
  // halos, colour mismatch, below-target resolution) and emits a QualityReport
  // via the backend `detect_quality_issues` command. Phase 1 is detect-only:
  // `fixed_image` is the unchanged input. Exposes the image passthrough, the
  // quality report, an optional issue overlay, and watchdog diagnostics.
  detailWatchdog: async (ctx) => {
    const image = (ctx.inputs.image as string | undefined) ?? null;
    if (!image) throw new Error("Detail Watchdog needs a connected image input");

    const outputDir = String(ctx.params.output_dir ?? "").trim() || (await getOutputDir());
    const result = await detectQualityIssues({
      image,
      visualContext: (ctx.inputs.visual_context as VisualContext | undefined) || undefined,
      targetBounds: (ctx.inputs.target_bounds as Bounds | undefined) || undefined,
      watchTargets: String(ctx.params.watch_targets ?? "").trim() || undefined,
      mode: String(ctx.params.mode ?? "balanced") || undefined,
      outputDir: outputDir || undefined,
      outputName: String(ctx.params.output_name ?? "").trim() || undefined,
    });
    return {
      fixed_image: result.fixed_image,
      quality_report: result.quality_report,
      issue_masks: result.issue_masks,
      watchdog_report: result.watchdog_report,
    };
  },
  // Writes the upstream image into the PSD template's placeholder (true
  // smart-object replacement when possible) and exports the .psd triplet via
  // the backend `compose_psd` command.
  psdExport: async (ctx) => {
    // A connected layered asset stands in for the flat image via its composite
    // preview, and its layer manifest is recorded in the exported metadata.
    const layeredAsset = (ctx.inputs.layered_asset as LayeredImageAsset | undefined) ?? null;
    const image =
      (ctx.inputs.image as string | undefined) ??
      layeredAsset?.preview_composite.path ??
      null;
    const template = (ctx.inputs.template as string | undefined) ?? null;
    if (!image) throw new Error("PSD Export needs a connected image or layered asset input");
    if (!template) throw new Error("PSD Export needs a connected PSD template input");

    // Fall back to the configured output directory when none is set on the node.
    const outputDir = String(ctx.params.output_dir ?? "").trim() || (await getOutputDir());
    if (!outputDir) throw new Error("PSD Export needs an output directory");

    const placeholderName = String(ctx.params.placeholder ?? "").trim();
    // Optional refined matte applied as the image's alpha, and any upstream
    // production metadata object merged into the exported _metadata.json.
    const mask = (ctx.inputs.mask as string | undefined) || undefined;
    const metadataInput = ctx.inputs.metadata;
    let metadata: string | undefined;
    if (layeredAsset) {
      let base: Record<string, unknown> = {};
      if (metadataInput != null) {
        if (typeof metadataInput === "string") {
          try {
            base = JSON.parse(metadataInput) as Record<string, unknown>;
          } catch {
            base = { metadata: metadataInput };
          }
        } else {
          base = metadataInput as Record<string, unknown>;
        }
      }
      metadata = JSON.stringify({ ...base, layered_asset: layeredAssetManifest(layeredAsset) });
    } else {
      metadata =
        metadataInput != null
          ? typeof metadataInput === "string"
            ? metadataInput
            : JSON.stringify(metadataInput)
          : undefined;
    }
    const result = await composePsd({
      template,
      image,
      mask,
      outputDir,
      filename: String(ctx.params.filename ?? "final") || "final",
      placeholder: placeholderName ? JSON.stringify({ name: placeholderName }) : undefined,
      fitMode: (String(ctx.params.fit_mode ?? "contain") as "contain" | "cover" | "stretch"),
      smartObjectMode: (String(ctx.params.smart_object_mode ?? "disable") as "disable" | "replace_content"),
      metadata,
    });
    if (result.status !== "succeeded") {
      throw new Error(`PSD export failed: ${result.status}`);
    }
    return {
      psdPath: result.psd_path,
      previewPath: result.preview_path || null,
      metadataPath: result.metadata_path,
      placeholderKind: result.placeholder_kind,
      smartObjectMode: result.smart_object_mode,
    };
  },
} satisfies ExecutorRegistry;
