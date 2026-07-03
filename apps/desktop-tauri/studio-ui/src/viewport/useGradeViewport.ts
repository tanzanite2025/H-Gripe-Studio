// Grade preview via the viewport host (WGPU migration Phase 3). The grading
// dialog owns one grade_preview viewport for its target: opened lazily on the
// first preview request (never at mount), parameter updates flow as
// `set_grade` on viewport state — the target reference and transport stay
// untouched per slider change — and the viewport is destroyed on unmount or
// when the target path changes.

import { useCallback, useEffect, useRef } from "react";
import { registerResource } from "../bridge/files";
import type { ViewportFrame } from "../bridge/viewport";
import { WgpuViewportHost } from "./WgpuViewportHost";

/** What the grading dialog points its viewport at: a still image, or one
 * decoded frame of a video (which takes precedence when set). */
export interface GradeViewportTarget {
  imagePath?: string | null;
  videoPath?: string | null;
  videoTimestampSec?: number;
}

interface OpenGradeViewport {
  host: WgpuViewportHost;
  resourceId: string;
}

/**
 * Returns `renderGraded(doc)`: apply `doc` to the target and render one graded
 * frame through the host. Resolves to `null` outside Tauri (browser preview),
 * where callers keep their in-webview mirror fallback.
 */
export function useGradeViewport(
  target: GradeViewportTarget,
  size = 1280,
): (doc: unknown) => Promise<ViewportFrame | null> {
  const { imagePath, videoPath, videoTimestampSec = 0 } = target;
  const path = videoPath ?? imagePath ?? undefined;
  const isVideo = Boolean(videoPath);
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
  }, [path, isVideo, size]);

  return useCallback(
    async (doc: unknown): Promise<ViewportFrame | null> => {
      if (!path) return null;
      if (!hostRef.current) {
        hostRef.current = (async () => {
          const res = await registerResource(path);
          if (!res) return null; // browser preview: no resource registry
          const host = await WgpuViewportHost.open("grade_preview");
          await host.command({ kind: "resize", width: size, height: size });
          return { host, resourceId: res.id };
        })();
      }
      const open = await hostRef.current;
      if (!open || !open.host.isOpen) return null;
      // The target carries the timestamp for video frames, so it is re-pointed
      // per render; a still image target is identical each time.
      await open.host.command({
        kind: "set_target",
        target: isVideo
          ? { kind: "video_frame", resourceId: open.resourceId, timeSec: timeRef.current }
          : { kind: "image", resourceId: open.resourceId },
      });
      await open.host.command({ kind: "set_grade", doc });
      return open.host.renderFrame();
    },
    [path, isVideo, size],
  );
}
