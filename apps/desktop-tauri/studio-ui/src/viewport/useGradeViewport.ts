// Grade preview via the viewport host (WGPU migration Phase 3). The grading
// dialog owns one grade_preview viewport for its target: opened lazily on the
// first preview request (never at mount), parameter updates flow as
// `set_grade` on viewport state — the target reference and transport stay
// untouched per slider change — and the viewport is destroyed on unmount or
// when the target path changes.

import { useCallback, useEffect, useRef } from "react";
import { tauriInvoke } from "../bridge/core";
import { registerResource } from "../bridge/files";
import { registerNodeOutput, type ViewportFrame } from "../bridge/viewport";
import { IDENTITY_VIEW, type ViewportViewState } from "./view";
import { WgpuViewportHost } from "./WgpuViewportHost";

/** What the grading dialog points its viewport at: a still image, or one
 * decoded frame of a video (which takes precedence when set). */
export interface GradeViewportTarget {
  imagePath?: string | null;
  videoPath?: string | null;
  videoTimestampSec?: number;
  /** When grading a node's output, present it as a `node_output` reference
   * target (the image path registers as the node's output artifact) instead
   * of a plain image resource. */
  nodeId?: string | null;
}

type GradeViewportRef =
  | { kind: "node_output"; nodeId: string }
  | { kind: "resource"; resourceId: string };

interface OpenGradeViewport {
  host: WgpuViewportHost;
  ref: GradeViewportRef;
  /** Last view sent to the host, to skip no-op `set_view` commands. */
  view: ViewportViewState;
}

/**
 * Returns `renderGraded(doc, view?)`: apply `doc` to the target and render one
 * graded frame of the (optionally zoomed/panned) view window through the
 * host. Resolves to `null` outside Tauri (browser preview), where callers
 * keep their in-webview mirror fallback.
 */
export function useGradeViewport(
  target: GradeViewportTarget,
  size = 1280,
): (doc: unknown, view?: ViewportViewState) => Promise<ViewportFrame | null> {
  const { imagePath, videoPath, videoTimestampSec = 0, nodeId } = target;
  const path = videoPath ?? imagePath ?? undefined;
  const isVideo = Boolean(videoPath);
  const nodeRef = isVideo ? undefined : (nodeId ?? undefined);
  const hostRef = useRef<Promise<OpenGradeViewport | null> | null>(null);
  const timeRef = useRef(videoTimestampSec);
  timeRef.current = videoTimestampSec;

  useEffect(() => {
    hostRef.current = null;
    return () => {
      const pending = hostRef.current;
      hostRef.current = null;
      void pending?.then((open) => open?.host.close());
    };
  }, [path, isVideo, nodeRef, size]);

  return useCallback(
    async (doc: unknown, view?: ViewportViewState): Promise<ViewportFrame | null> => {
      if (!path) return null;
      if (!hostRef.current) {
        hostRef.current = (async () => {
          let ref: GradeViewportRef;
          if (nodeRef) {
            // Node outputs resolve host-side through the node output
            // registry; outside Tauri callers keep their mirror fallback.
            if (!tauriInvoke()) return null;
            await registerNodeOutput(nodeRef, path);
            ref = { kind: "node_output", nodeId: nodeRef };
          } else {
            const res = await registerResource(path);
            if (!res) return null; // browser preview: no resource registry
            ref = { kind: "resource", resourceId: res.id };
          }
          const host = await WgpuViewportHost.open("grade_preview");
          await host.command({ kind: "resize", width: size, height: size });
          return { host, ref, view: IDENTITY_VIEW };
        })();
      }
      const open = await hostRef.current;
      if (!open || !open.host.isOpen) return null;
      // The target carries the timestamp for video frames, so it is re-pointed
      // per render; a still image target is identical each time.
      await open.host.command({
        kind: "set_target",
        target:
          open.ref.kind === "node_output"
            ? { kind: "node_output", nodeId: open.ref.nodeId }
            : isVideo
              ? { kind: "video_frame", resourceId: open.ref.resourceId, timeSec: timeRef.current }
              : { kind: "image", resourceId: open.ref.resourceId },
      });
      await open.host.command({ kind: "set_grade", doc });
      // Zoom/pan is viewport state (Phase 3): the host crops the cached
      // source proxy, so a view change never re-decodes the target.
      const next = view ?? IDENTITY_VIEW;
      if (
        next.zoom !== open.view.zoom ||
        next.panX !== open.view.panX ||
        next.panY !== open.view.panY
      ) {
        await open.host.command({ kind: "set_view", ...next });
        open.view = next;
      }
      return open.host.renderFrame();
    },
    [path, isVideo, nodeRef, size],
  );
}
