import { isGradeOpType } from "./gradeKernel";
import { imageEditorBridgeGap, type ImageDocument } from "./imageDocument";

export type ImageDocumentEditBlockCode =
  | "invalid-document"
  | "unsupported-grade-op"
  | "grade-ops-not-rewriteable"
  | "editor-bridge-gap";

export interface ImageDocumentEditBlock {
  code: ImageDocumentEditBlockCode;
  detail: string;
}

interface GradeOpScan {
  firstGradePath: string | null;
  block: ImageDocumentEditBlock | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The manifest must retain an unsupported draft so a later save cannot erase
 * it. This guard checks only the versioned envelope; editability is separate.
 */
export function isPersistedImageDocumentEnvelope(value: unknown): value is ImageDocument {
  return isRecord(value) && value.version === 1 && Array.isArray(value.layers);
}

function layerPath(layer: Record<string, unknown>, index: number, parent: string): string {
  const label = typeof layer.name === "string" && layer.name ? layer.name : `#${index + 1}`;
  return parent ? `${parent} / ${label}` : label;
}

function unsupportedGradeOp(path: string, value: unknown): ImageDocumentEditBlock {
  const type = isRecord(value) && typeof value.type === "string" ? value.type : "(missing type)";
  return {
    code: "unsupported-grade-op",
    detail: `Layer "${path}" contains unsupported or retired grade operation "${type}".`,
  };
}

function scanGradeOps(rawLayers: unknown, parent = ""): GradeOpScan {
  if (!Array.isArray(rawLayers)) {
    return {
      firstGradePath: null,
      block: { code: "invalid-document", detail: "The stored image document has an invalid layer list." },
    };
  }

  let firstGradePath: string | null = null;
  for (let index = 0; index < rawLayers.length; index++) {
    const rawLayer = rawLayers[index];
    if (!isRecord(rawLayer) || !isRecord(rawLayer.layer)) {
      return {
        firstGradePath,
        block: { code: "invalid-document", detail: `Stored layer #${index + 1} is malformed.` },
      };
    }

    const path = layerPath(rawLayer, index, parent);
    const layer = rawLayer.layer;
    if (layer.kind === "adjustment") {
      if (Object.prototype.hasOwnProperty.call(layer, "ops")) {
        if (!Array.isArray(layer.ops)) {
          return {
            firstGradePath,
            block: { code: "invalid-document", detail: `Layer "${path}" has an invalid grade operation list.` },
          };
        }
        firstGradePath ??= path;
        for (const op of layer.ops) {
          if (!isRecord(op) || !isGradeOpType(op.type)) {
            return { firstGradePath, block: unsupportedGradeOp(path, op) };
          }
        }
      }
      continue;
    }

    if (layer.kind === "group") {
      const nested = scanGradeOps(layer.children, path);
      firstGradePath ??= nested.firstGradePath;
      if (nested.block) return { firstGradePath, block: nested.block };
      continue;
    }

    if (layer.kind !== "pixel") {
      return {
        firstGradePath,
        block: { code: "invalid-document", detail: `Layer "${path}" has an unknown layer kind.` },
      };
    }
  }
  return { firstGradePath, block: null };
}

/**
 * Return why a persisted ImageDocument must stay read-only at the current
 * image-editor boundary. Retired operations are found inside nested groups
 * before bridge checks, so they can never be replaced by a blank document.
 */
export function imageDocumentEditBlock(value: unknown): ImageDocumentEditBlock | null {
  if (!isPersistedImageDocumentEnvelope(value)) {
    return { code: "invalid-document", detail: "The stored image document is malformed or incompatible." };
  }

  const scan = scanGradeOps(value.layers);
  if (scan.block) return scan.block;
  if (scan.firstGradePath) {
    return {
      code: "grade-ops-not-rewriteable",
      detail: `Layer "${scan.firstGradePath}" contains grade operations that this image editor cannot rewrite safely.`,
    };
  }

  const gap = imageEditorBridgeGap(value);
  return gap
    ? { code: "editor-bridge-gap", detail: `This image editor cannot rewrite ${gap}.` }
    : null;
}
