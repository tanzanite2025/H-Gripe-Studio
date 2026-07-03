// Unified production selection model (UNIFIED_PRODUCTION_DRAWER_PLAN.md).
//
// The bottom production drawer and the on-demand editors (image / mask / crop /
// audio / export) all work against one selection target instead of asking
// "am I the image dialog or the video dialog". Renderer-agnostic and
// dependency-free so it stays unit testable.

export type ProductionTarget =
  | { kind: "asset"; assetId: string }
  | { kind: "image"; assetId: string; sourceNodeId?: string }
  | { kind: "image_layer"; workspaceId: string; layerId: string }
  | { kind: "video_clip"; timelineId: string; trackId: string; clipId: string; frame?: number }
  | { kind: "audio_clip"; timelineId: string; trackId: string; clipId: string; time?: number }
  | { kind: "node_output"; nodeId: string; outputPort?: string }
  | { kind: "timeline"; timelineId: string };

export function assetTarget(assetId: string): ProductionTarget {
  return { kind: "asset", assetId };
}

export function nodeOutputTarget(nodeId: string, outputPort?: string): ProductionTarget {
  return outputPort ? { kind: "node_output", nodeId, outputPort } : { kind: "node_output", nodeId };
}

/** Stable identity string for a target, for selection comparison / memo keys. */
export function targetKey(target: ProductionTarget | null): string {
  if (!target) return "none";
  switch (target.kind) {
    case "asset":
      return `asset:${target.assetId}`;
    case "image":
      return `image:${target.assetId}`;
    case "image_layer":
      return `image_layer:${target.workspaceId}:${target.layerId}`;
    case "video_clip":
      return `video_clip:${target.timelineId}:${target.trackId}:${target.clipId}`;
    case "audio_clip":
      return `audio_clip:${target.timelineId}:${target.trackId}:${target.clipId}`;
    case "node_output":
      return `node_output:${target.nodeId}${target.outputPort ? `:${target.outputPort}` : ""}`;
    case "timeline":
      return `timeline:${target.timelineId}`;
  }
}

export function sameTarget(a: ProductionTarget | null, b: ProductionTarget | null): boolean {
  return targetKey(a) === targetKey(b);
}
