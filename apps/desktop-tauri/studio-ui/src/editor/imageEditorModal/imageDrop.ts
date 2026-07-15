import type { LayerImageSource } from "../../contracts/imageEditOps";
import { isSupportedImagePath } from "../../domain/mediaFormats";

export type ImageDimensionProbe = (
  path: string,
) => Promise<{ width: number; height: number } | null>;

export function isImageEditorDropOwner(target: Element | null): boolean {
  return Boolean(target?.closest(".image-editor"));
}

export function isImageEditorStageDrop(target: Element | null): boolean {
  return Boolean(target?.closest(".image-editor-stage"));
}

export async function resolveDroppedImageSources(
  paths: readonly string[],
  probe: ImageDimensionProbe,
): Promise<LayerImageSource[]> {
  const candidates = paths.filter(isSupportedImagePath);
  const resolved = await Promise.all(candidates.map(async (path) => {
    const dimensions = await probe(path);
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
    return { path, width: dimensions.width, height: dimensions.height };
  }));
  return resolved.filter((source): source is LayerImageSource => source !== null);
}
