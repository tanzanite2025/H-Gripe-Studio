import { type MaskDocument, type MaskLayer } from "../contracts/maskDocument";
import type { MsgKey } from "../i18n";
import type { StudioTarget } from "./studioTarget";

export type CommandId =
  | "layer.invert"
  | "layer.link"
  | "layer.addMask"
  | "layer.duplicate"
  | "layer.add"
  | "target.delete"
  | "mask.invert"
  | "mask.delete"
  | "mask.disable"
  | "selection.toMask"
  | "selection.invert"
  | "path.makeSelection"
  | "target.transform"
  | "ai.selectSubject"
  | "ai.removeBackground";

export interface StudioCommand {
  id: CommandId;
  titleKey: MsgKey;
  icon: string;
  group: "layer" | "mask" | "selection" | "path" | "transform" | "ai";
  danger?: boolean;
  requiresPreview?: boolean;
}

export interface CommandCapability {
  enabled: boolean;
  reason?: string;
  danger?: boolean;
  requiresPreview?: boolean;
}

export interface CommandContext {
  doc: MaskDocument;
  target: StudioTarget;
  backendAvailable?: boolean;
}

export const STUDIO_COMMANDS: Record<CommandId, StudioCommand> = {
  "layer.invert": { id: "layer.invert", titleKey: "mask.layerInvertTitle", icon: "invert", group: "layer" },
  "layer.link": { id: "layer.link", titleKey: "mask.layerLink", icon: "link", group: "layer" },
  "layer.addMask": { id: "layer.addMask", titleKey: "mask.layerMaskAddTitle", icon: "mask", group: "layer" },
  "layer.duplicate": { id: "layer.duplicate", titleKey: "mask.layerDuplicate", icon: "duplicate", group: "layer" },
  "layer.add": { id: "layer.add", titleKey: "mask.layerAddTitle", icon: "add", group: "layer" },
  "target.delete": { id: "target.delete", titleKey: "mask.layerDelete", icon: "delete", group: "layer", danger: true },
  "mask.invert": { id: "mask.invert", titleKey: "mask.layerInvertTitle", icon: "invert", group: "mask" },
  "mask.delete": { id: "mask.delete", titleKey: "mask.maskDelete", icon: "delete", group: "mask", danger: true },
  "mask.disable": { id: "mask.disable", titleKey: "mask.maskDisable", icon: "visibility-off", group: "mask" },
  "selection.toMask": { id: "selection.toMask", titleKey: "mask.maskAdd", icon: "mask", group: "selection" },
  "selection.invert": { id: "selection.invert", titleKey: "mask.selectInvert", icon: "invert", group: "selection" },
  "path.makeSelection": { id: "path.makeSelection", titleKey: "mask.pathMakeSelection", icon: "selection", group: "path" },
  "target.transform": { id: "target.transform", titleKey: "mask.freeTransform", icon: "transform", group: "transform" },
  "ai.selectSubject": { id: "ai.selectSubject", titleKey: "mask.selectSubject", icon: "subject", group: "ai", requiresPreview: true },
  "ai.removeBackground": { id: "ai.removeBackground", titleKey: "mask.removeBackground", icon: "background-remove", group: "ai", requiresPreview: true },
};

function disabled(reason: string, command: StudioCommand): CommandCapability {
  return { enabled: false, reason, danger: command.danger, requiresPreview: command.requiresPreview };
}

function enabled(command: StudioCommand): CommandCapability {
  return { enabled: true, danger: command.danger, requiresPreview: command.requiresPreview };
}

function layerById(doc: MaskDocument, layerId: string): { layer: MaskLayer; index: number } | null {
  const index = doc.layers.findIndex((layer) => layer.id === layerId);
  return index >= 0 ? { layer: doc.layers[index], index } : null;
}

function targetLayer(doc: MaskDocument, target: StudioTarget): { layer: MaskLayer; index: number } | null {
  if (target.kind !== "pixel_layer" && target.kind !== "layer_mask") return null;
  return layerById(doc, target.layerId);
}

function editablePixelLayer(doc: MaskDocument, target: StudioTarget): { layer: MaskLayer; index: number } | null {
  if (target.kind !== "pixel_layer") return null;
  const found = layerById(doc, target.layerId);
  if (!found || found.layer.kind === "adjustment" || found.layer.locked) return null;
  return found;
}

function editableMaskTarget(doc: MaskDocument, target: StudioTarget): { layer: MaskLayer; index: number } | null {
  if (target.kind !== "layer_mask") return null;
  const found = layerById(doc, target.layerId);
  if (!found || found.layer.locked || !found.layer.mask || found.layer.mask.id !== target.maskId) return null;
  return found;
}

export function getCommand(commandId: CommandId): StudioCommand {
  return STUDIO_COMMANDS[commandId];
}

export function getCommandCapability(commandId: CommandId, ctx: CommandContext): CommandCapability {
  const command = getCommand(commandId);
  const { doc, target } = ctx;
  switch (commandId) {
    case "layer.add":
      return enabled(command);
    case "layer.duplicate": {
      const found = targetLayer(doc, target);
      if (!found) return disabled("target is not a layer", command);
      if (found.layer.locked) return disabled("layer is locked", command);
      return enabled(command);
    }
    case "layer.link": {
      const found = targetLayer(doc, target);
      return found ? enabled(command) : disabled("target is not a layer", command);
    }
    case "layer.invert": {
      return editablePixelLayer(doc, target) ? enabled(command) : disabled("target is not an editable pixel layer", command);
    }
    case "layer.addMask": {
      const found = editablePixelLayer(doc, target);
      if (!found) return disabled("target is not an editable pixel layer", command);
      if (found.layer.mask) return disabled("layer already has a mask", command);
      return enabled(command);
    }
    case "target.delete": {
      if (target.kind === "layer_mask") return getCommandCapability("mask.delete", ctx);
      const found = targetLayer(doc, target);
      if (!found) return disabled("target is not deletable", command);
      if (found.layer.locked) return disabled("layer is locked", command);
      return enabled(command);
    }
    case "mask.invert":
    case "mask.disable":
    case "mask.delete": {
      return editableMaskTarget(doc, target) ? enabled(command) : disabled("target is not an editable layer mask", command);
    }
    case "selection.toMask":
    case "selection.invert": {
      return target.kind === "selection" ? enabled(command) : disabled("target is not a selection", command);
    }
    case "path.makeSelection": {
      return target.kind === "path" ? enabled(command) : disabled("target is not a path", command);
    }
    case "target.transform": {
      return editablePixelLayer(doc, target) ? enabled(command) : disabled("target cannot be transformed", command);
    }
    case "ai.selectSubject":
    case "ai.removeBackground": {
      const found = editablePixelLayer(doc, target);
      if (!found) return disabled("target is not an editable pixel layer", command);
      if (!ctx.backendAvailable) return disabled("required compute backend is unavailable", command);
      return enabled(command);
    }
  }
}

export function availableCommands(commandIds: readonly CommandId[], ctx: CommandContext): CommandId[] {
  return commandIds.filter((id) => getCommandCapability(id, ctx).enabled);
}
