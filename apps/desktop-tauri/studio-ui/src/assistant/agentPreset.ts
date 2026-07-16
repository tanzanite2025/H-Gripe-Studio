// Page-context agent presets (docs/plans/active/
// PAGE_CONTEXT_AGENT_PRESET_PLAN.md, steps 1–6). One assistant shell, one
// agent runtime: the active workspace loads a preset that is a *capability
// boundary*, not just a prompt — what the assistant may read, which Studio
// Actions it may call, which backend capability it prefers, and when cost
// needs an explicit confirmation. Enforcement happens before any write
// action: a proposal step whose action id is outside the preset whitelist is
// rejected up front, exactly like an unknown action id at the agent boundary.
//
//   Assistant shell -> PageContext -> AgentPreset
//     -> allowed reads -> allowed Studio Actions -> dry-run / preview / commit

import type { AgentProposal } from "../editor/studioAgent";
import type { ActionPlan } from "../editor/studioAction";
import type { StudioTarget } from "../editor/studioTarget";
import { describeTarget } from "../editor/studioTarget";
import type { RunScope } from "../runtime/runScope";
import { describeRunScope } from "../runtime/runScope";
import type { ComputeCostClass } from "../editor/computeBlocks";

/** The active workspace plus what is selected/open there. */
export type AgentWorkspace =
  | "project"
  | "canvas"
  | "image_editor"
  | "timeline_grade"
  | "model_api"
  | "settings";

export interface PageContext {
  workspace: AgentWorkspace;
  activeCanvasId?: string;
  activeDocumentId?: string;
  selectedNodeIds?: string[];
  selectedTargets?: StudioTarget[];
  activeRunScope?: RunScope;
  openPanelId?: string;
}

/** When API / local-heavy work needs a confirmation gate. */
export type AgentCostPolicy = "local_only" | "confirm_api" | "confirm_expensive";

export interface AgentPreset {
  id: string;
  label: string;
  /** One-line boundary statement shown in the review UI / system prompt. */
  systemPolicy: string;
  /** Context models the assistant may read (read scopes, never raw secrets). */
  allowedReadModels: string[];
  /** Studio Action ids this preset may propose; everything else is rejected. */
  allowedActionIds: string[];
  /** Explicitly banned ids, checked even if a future whitelist grows. */
  forbiddenActionIds?: string[];
  /** Model-manager capability the preset prefers when resolving backends. */
  defaultBackendCapability: string;
  costPolicy: AgentCostPolicy;
}

// --- static preset registry (plan step 2) ------------------------------------

const projectPreset: AgentPreset = {
  id: "preset.project",
  label: "Project",
  systemPolicy:
    "Project structure, files, settings, and planning. Never edits pixels, masks, secrets, or exports.",
  allowedReadModels: [
    "project_manifest",
    "canvas_list",
    "asset_registry",
    "recent_run_reports",
    "settings_status",
  ],
  allowedActionIds: [
    "open_project_panel",
    "create_canvas",
    "rename_canvas",
    "open_asset_panel",
    "show_project_settings",
  ],
  forbiddenActionIds: [
    "edit_image_pixels",
    "mutate_layer_mask",
    "change_api_secret",
    "run_expensive_model",
    "export_final_media",
  ],
  defaultBackendCapability: "",
  costPolicy: "local_only",
};

const canvasPreset: AgentPreset = {
  id: "preset.canvas",
  label: "Canvas",
  systemPolicy:
    "Node graph understanding, wiring diagnosis, and run scopes. Never edits credentials, layer pixels, or raw graph JSON.",
  allowedReadModels: [
    "selected_nodes",
    "node_specs",
    "edges",
    "run_reports",
    "backend_validation_reports",
    "output_cache_summaries",
  ],
  allowedActionIds: [
    "explain_selected_nodes",
    "validate_backend_refs",
    "run_selected_with_upstream",
    "run_to_node",
    "run_downstream",
    "open_node_result_preview",
  ],
  forbiddenActionIds: [
    "change_api_secret",
    "edit_image_pixels",
    "rewrite_graph_json",
    "run_full_canvas",
  ],
  defaultBackendCapability: "",
  costPolicy: "confirm_expensive",
};

const imageEditorPreset: AgentPreset = {
  id: "preset.image_editor",
  label: "Image Editor",
  systemPolicy:
    "Layers, masks, selections, paths, and previewable image operations on resolved targets. Never creates projects, touches secrets, runs the canvas, or applies masks destructively without confirmation.",
  allowedReadModels: [
    "active_document",
    "layer_stack",
    "active_layer_target",
    "layer_mask_targets",
    "selection_targets",
    "path_targets",
    "history_stack",
    "viewport_pixels_readonly",
  ],
  // The registered Studio Actions of the mask/layer target plan (steps 6–8),
  // plus the preview/commit split ids the plan reserves for the shared
  // preview gate.
  allowedActionIds: [
    "set_active_target",
    "create_layer_mask",
    "record_point_selection",
    "commit_selection_alpha_artifact_to_layer_mask",
    "generate_selection_from_path",
    "commit_selection_to_layer_mask",
    "feather_layer_mask",
    "undo_editor_action",
    "open_operation_preview",
  ],
  forbiddenActionIds: [
    "new_project",
    "change_api_secret",
    "run_full_canvas",
    "edit_timeline_tracks",
    "destructive_apply_mask",
  ],
  defaultBackendCapability: "mask.subject",
  costPolicy: "confirm_expensive",
};

const timelineGradePreset: AgentPreset = {
  id: "preset.timeline_grade",
  label: "Timeline / Grade",
  systemPolicy:
    "Clips, timeline run scopes, grade targets, and export preparation. Never edits credentials, image-editor masks, or exports without confirmation.",
  allowedReadModels: [
    "active_timeline",
    "selected_clips",
    "track_state",
    "grade_stack",
    "render_preview_status",
    "av_device_reports",
  ],
  allowedActionIds: [
    "open_clip_editor",
    "open_grade_panel",
    "apply_grade_preview",
    "add_keyframe_preview",
    "run_timeline_preview",
    "prepare_export_report",
    "undo_timeline_action",
  ],
  forbiddenActionIds: [
    "change_api_secret",
    "mutate_layer_mask",
    "delete_project",
    "export_final_media",
  ],
  defaultBackendCapability: "",
  costPolicy: "confirm_expensive",
};

const modelApiPreset: AgentPreset = {
  id: "preset.model_api",
  label: "API Profiles",
  systemPolicy:
    "API provider profiles and capability checks. Never reads raw keys, writes secrets, or edits layers.",
  allowedReadModels: [
    "api_profile_registry_no_secrets",
    "capability_map",
    "backend_health_status",
    "backend_validation_errors",
  ],
  allowedActionIds: [
    "open_model_api_manager",
    "test_api_profile",
    "show_missing_capability_report",
  ],
  forbiddenActionIds: [
    "read_raw_api_keys",
    "write_secrets_into_graph",
    "edit_image_pixels",
    "delete_model_files",
  ],
  defaultBackendCapability: "",
  costPolicy: "confirm_api",
};

const settingsPreset: AgentPreset = {
  id: "preset.settings",
  label: "Settings",
  systemPolicy: "Preference explanation and navigation to settings panels only.",
  allowedReadModels: ["settings_status"],
  allowedActionIds: [
    "open_settings",
    "open_shortcuts",
    "open_language_settings",
    "open_about",
    "open_diagnostics",
  ],
  defaultBackendCapability: "",
  costPolicy: "local_only",
};

const PRESETS: Record<AgentWorkspace, AgentPreset> = {
  project: projectPreset,
  canvas: canvasPreset,
  image_editor: imageEditorPreset,
  timeline_grade: timelineGradePreset,
  model_api: modelApiPreset,
  settings: settingsPreset,
};

/** The preset the active workspace loads (auto mode). */
export function presetForWorkspace(workspace: AgentWorkspace): AgentPreset {
  return PRESETS[workspace];
}

/**
 * Resolve the preset for the assistant header: auto-follow the page context,
 * unless the user pinned a mode for a cross-context question.
 */
export function resolvePreset(ctx: PageContext, pinned?: AgentWorkspace): AgentPreset {
  return presetForWorkspace(pinned ?? ctx.workspace);
}

/** All presets, for the header mode menu. */
export function listPresets(): AgentPreset[] {
  return Object.values(PRESETS);
}

// --- read-only context summary (plan step 4) ----------------------------------

/**
 * The target summary line the assistant header shows next to the mode, e.g.
 * `Layer Mask: layer-7 · Selected Nodes: 3 · Scope: up to node-4`.
 */
export function describePageContext(ctx: PageContext): string {
  const parts: string[] = [];
  if (ctx.activeDocumentId) parts.push(`Document: ${ctx.activeDocumentId}`);
  if (ctx.activeCanvasId) parts.push(`Canvas: ${ctx.activeCanvasId}`);
  for (const target of ctx.selectedTargets ?? []) parts.push(describeTarget(target));
  if (ctx.selectedNodeIds?.length) parts.push(`Selected Nodes: ${ctx.selectedNodeIds.length}`);
  if (ctx.activeRunScope) parts.push(`Scope: ${describeRunScope(ctx.activeRunScope)}`);
  if (ctx.openPanelId) parts.push(`Panel: ${ctx.openPanelId}`);
  return parts.join(" · ");
}

// --- whitelist / cost enforcement (plan step 5) --------------------------------

export type AgentPermission =
  | { kind: "read"; scope: string }
  | { kind: "action"; actionId: string }
  | { kind: "backend"; capability: string }
  | { kind: "cost"; policy: "free" | "local_heavy" | "api_billable" };

/** Whether the preset lets the assistant read a context model. */
export function presetAllowsRead(preset: AgentPreset, scope: string): boolean {
  return preset.allowedReadModels.includes(scope);
}

/** Whether the preset lets the assistant propose an action id. */
export function presetAllowsAction(preset: AgentPreset, actionId: string): boolean {
  if (preset.forbiddenActionIds?.includes(actionId)) return false;
  return preset.allowedActionIds.includes(actionId);
}

export interface PresetGuardResult {
  ok: boolean;
  /** Per-step violations, `step N: ...`, empty when ok. */
  violations: string[];
}

/**
 * Check every proposal step against the preset whitelist *before* target
 * resolution / dry run. Fails closed and reports every violation, so the
 * review UI can show all of them at once.
 */
export function guardProposal(proposal: AgentProposal, preset: AgentPreset): PresetGuardResult {
  const violations: string[] = [];
  proposal.steps.forEach((step, i) => {
    if (!presetAllowsAction(preset, step.actionId)) {
      violations.push(`step ${i + 1}: "${step.actionId}" is outside the ${preset.label} preset`);
    }
  });
  return { ok: violations.length === 0, violations };
}

/** What the cost policy says about running a planned action. */
export type CostGate = "allow" | "confirm" | "refuse";

/**
 * Gate a dry-run plan's cost class through the preset policy: `local_only`
 * refuses API spend, `confirm_api` confirms it, `confirm_expensive` also
 * confirms local-heavy compute. Free actions always pass (destructive
 * confirmation stays with the normal preview/commit transaction).
 */
export function costGateFor(costClass: ComputeCostClass, policy: AgentCostPolicy): CostGate {
  if (costClass === "free") return "allow";
  if (costClass === "api_paid") return policy === "local_only" ? "refuse" : "confirm";
  // local_compute
  return policy === "confirm_expensive" ? "confirm" : "allow";
}

/** The gate for a whole reviewed plan list: the strictest step wins. */
export function costGateForPlans(plans: ActionPlan[], preset: AgentPreset): CostGate {
  let gate: CostGate = "allow";
  for (const plan of plans) {
    const step = costGateFor(plan.costClass, preset.costPolicy);
    if (step === "refuse") return "refuse";
    if (step === "confirm") gate = "confirm";
  }
  return gate;
}
