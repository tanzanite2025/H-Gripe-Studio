import type { PortSpec } from "../graph/model";

export interface ImageSourceSlot {
  id: string;
  label: string;
  role: string;
  color: string;
  path: string;
  editorDraftId: string;
}

const SLOT_PREFIX = "slot-";
const PORT_PREFIX = "image:";
const DEFAULT_ROLE = "image";
export const MAX_IMAGE_SOURCE_SLOTS = 5;
const SLOT_COLORS = [
  "#6fd39a",
  "#6cb2ff",
  "#ffc861",
  "#c39bf2",
  "#ff8ac2",
  "#4fc3f7",
  "#ffab70",
  "#b3e07a",
];
const SLOT_LABELS = ["A", "B", "C", "D", "E"];

function cleanPath(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function slotLabel(index: number): string {
  return SLOT_LABELS[index] ?? String(index + 1);
}

function slotId(index: number): string {
  return `${SLOT_PREFIX}${slotLabel(index).toLowerCase()}`;
}

function slotColor(index: number): string {
  return SLOT_COLORS[index % SLOT_COLORS.length];
}

function normalizeSlot(raw: unknown, index: number): ImageSourceSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const path = cleanPath(item.path);
  if (!path) return null;
  const fallbackId = slotId(index);
  const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : fallbackId;
  const label =
    typeof item.label === "string" && item.label.trim() ? item.label.trim() : slotLabel(index);
  const role =
    typeof item.role === "string" && item.role.trim() ? item.role.trim() : DEFAULT_ROLE;
  const color =
    typeof item.color === "string" && item.color.trim() ? item.color.trim() : slotColor(index);
  const editorDraftId =
    typeof item.editorDraftId === "string" && item.editorDraftId.trim()
      ? item.editorDraftId.trim()
      : id;
  return { id, label, role, color, path, editorDraftId };
}

export function imageSourceSlotPortId(slotIdValue: string): string {
  return `${PORT_PREFIX}${slotIdValue}`;
}

export function imageSourceSlotIdFromPortId(portId: string | null | undefined): string | null {
  if (!portId || !portId.startsWith(PORT_PREFIX)) return null;
  const id = portId.slice(PORT_PREFIX.length);
  return id || null;
}

export function imageSourceParamsFromPaths(paths: string[]): Record<string, unknown> {
  const images = paths
    .slice(0, MAX_IMAGE_SOURCE_SLOTS)
    .map((path, index) => ({
      id: slotId(index),
      label: slotLabel(index),
      role: index === 0 ? "main" : DEFAULT_ROLE,
      color: slotColor(index),
      path,
      editorDraftId: slotId(index),
    }))
    .filter((slot) => cleanPath(slot.path));
  return {
    path: images[0]?.path ?? "",
    images,
  };
}

export function appendImageSourcePaths(
  params: Record<string, unknown> | null | undefined,
  paths: string[],
): Record<string, unknown> {
  const current = normalizeImageSourceSlots(params);
  const remaining = Math.max(0, MAX_IMAGE_SOURCE_SLOTS - current.length);
  const additions = paths
    .map((path) => path.trim())
    .filter(Boolean)
    .slice(0, remaining)
    .map((path, offset) => {
      const index = current.length + offset;
      return {
        id: slotId(index),
        label: slotLabel(index),
        role: index === 0 ? "main" : DEFAULT_ROLE,
        color: slotColor(index),
        path,
        editorDraftId: slotId(index),
      };
    });
  const images = [...current, ...additions];
  return {
    ...(params ?? {}),
    path: images[0]?.path ?? "",
    images,
  };
}

export function imageSourcePathGroups(paths: string[]): string[][] {
  const clean = paths.map((path) => path.trim()).filter(Boolean);
  const groups: string[][] = [];
  for (let index = 0; index < clean.length; index += MAX_IMAGE_SOURCE_SLOTS) {
    groups.push(clean.slice(index, index + MAX_IMAGE_SOURCE_SLOTS));
  }
  return groups;
}

export function normalizeImageSourceSlots(params: Record<string, unknown> | null | undefined): ImageSourceSlot[] {
  const rawImages = params?.images;
  const slots = Array.isArray(rawImages)
    ? rawImages
        .slice(0, MAX_IMAGE_SOURCE_SLOTS)
        .map((item, index) => normalizeSlot(item, index))
        .filter((slot): slot is ImageSourceSlot => slot != null)
    : [];
  if (slots.length > 0) return slots;

  const path = cleanPath(params?.path);
  if (!path) return [];
  return [
    {
      id: slotId(0),
      label: slotLabel(0),
      role: "main",
      color: slotColor(0),
      path,
      editorDraftId: slotId(0),
    },
  ];
}

export function firstImageSourceSlotPortId(params: Record<string, unknown> | null | undefined): string {
  const first = normalizeImageSourceSlots(params)[0];
  return first ? imageSourceSlotPortId(first.id) : "image";
}

export function imageSourceSlotForPortId(
  params: Record<string, unknown> | null | undefined,
  portId: string | null | undefined,
): ImageSourceSlot | null {
  const slots = normalizeImageSourceSlots(params);
  if (portId === "image") return slots[0] ?? null;
  const slotIdValue = imageSourceSlotIdFromPortId(portId);
  if (!slotIdValue) return null;
  return slots.find((slot) => slot.id === slotIdValue) ?? null;
}

export function imageSourceOutputPort(
  params: Record<string, unknown> | null | undefined,
  portId: string | null | undefined,
): PortSpec | undefined {
  const slot = imageSourceSlotForPortId(params, portId);
  if (!slot) return undefined;
  return {
    id: portId === "image" ? "image" : imageSourceSlotPortId(slot.id),
    label: slot.label,
    type: "image",
  };
}

export function imageSourceSlotColorForPort(
  params: Record<string, unknown> | null | undefined,
  portId: string | null | undefined,
): string | undefined {
  return imageSourceSlotForPortId(params, portId)?.color;
}
