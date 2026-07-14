import type { ViewportImageScene, ViewportTarget } from "../bridge/viewport";

/** A path that still needs resource registration or an already resolved host target. */
export type ViewportUnderlaySource = string | ViewportTarget;

/** Resource target identity. Image-composite document revisions are scene
 * commits and deliberately do not change this key. */
export function viewportUnderlaySourceTargetKey(source: ViewportUnderlaySource | undefined): string {
  if (source === undefined) return "none";
  if (typeof source === "string") return `path:${source}`;
  switch (source.kind) {
    case "image":
      return `image:${source.resourceId}`;
    case "image_layer":
      return `image_layer:${source.assetId}:${source.layerId}`;
    case "image_composite":
      return `image_composite:${source.resourceId}`;
    case "video_clip":
      return `video_clip:${source.timelineId}:${source.clipId}:${source.timeSec}`;
    case "video_frame":
      return `video_frame:${source.resourceId}:${source.timeSec}`;
    case "node_output":
      return `node_output:${source.nodeId}${source.outputPort ? `:${source.outputPort}` : ""}`;
  }
}

export function viewportUnderlaySourceImageScene(
  source: ViewportUnderlaySource | undefined,
): ViewportImageScene | null {
  if (typeof source !== "object" || source.kind !== "image_composite") return null;
  return {
    document: source.document,
    documentKey: source.documentKey,
    documentWidth: source.documentWidth,
    documentHeight: source.documentHeight,
    frameX: source.frameX ?? 0,
    frameY: source.frameY ?? 0,
    frameWidth: source.frameWidth ?? source.documentWidth,
    frameHeight: source.frameHeight ?? source.documentHeight,
  };
}

export function viewportUnderlaySourceSceneKey(
  source: ViewportUnderlaySource | undefined,
): string | null {
  const scene = viewportUnderlaySourceImageScene(source);
  if (!scene) return null;
  return [
    "image_scene",
    scene.documentKey,
    `${scene.documentWidth}x${scene.documentHeight}`,
    `${scene.frameX},${scene.frameY}`,
    `${scene.frameWidth}x${scene.frameHeight}`,
  ].join(":");
}

/** Viewport-host lifetime identity. Mutable image scenes reuse their host and
 * resource target while document revisions use `set_image_scene`. */
export function viewportUnderlaySourceHostKey(source: ViewportUnderlaySource | undefined): string {
  if (source === undefined) return "none";
  if (typeof source === "string") return `path:${source}`;
  switch (source.kind) {
    case "image":
      return `image:${source.resourceId}`;
    case "image_layer":
      return `image_layer:${source.assetId}:${source.layerId}`;
    case "image_composite":
      return `image_composite:${source.resourceId}`;
    case "video_clip":
      return `video_clip:${source.timelineId}:${source.clipId}`;
    case "video_frame":
      return `video_frame:${source.resourceId}`;
    case "node_output":
      return `node_output:${source.nodeId}${source.outputPort ? `:${source.outputPort}` : ""}`;
  }
}
