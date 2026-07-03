// Grade preview via the viewport host (WGPU migration Phase 3). The grading
// dialog owns one grade_preview viewport for its target image: opened lazily
// on the first preview request (never at mount), parameter updates flow as
// `set_grade` on viewport state — the target reference and transport stay
// untouched per slider change — and the viewport is destroyed on unmount or
// when the target path changes.

import { useCallback, useEffect, useRef } from "react";
import { registerResource } from "../bridge/files";
import type { ViewportFrame } from "../bridge/viewport";
import { WgpuViewportHost } from "./WgpuViewportHost";

/**
 * Returns `renderGraded(doc)`: apply `doc` to the image and render one graded
 * frame through the host. Resolves to `null` outside Tauri (browser preview),
 * where callers keep their in-webview mirror fallback.
 */
export function useGradeViewport(
  imagePath: string | undefined,
  size = 1280,
): (doc: unknown) => Promise<ViewportFrame | null> {
  const hostRef = useRef<Promise<WgpuViewportHost | null> | null>(null);

  useEffect(() => {
    hostRef.current = null;
    return () => {
      const pending = hostRef.current;
      hostRef.current = null;
      void pending?.then((host) => host?.close());
    };
  }, [imagePath, size]);

  return useCallback(
    async (doc: unknown): Promise<ViewportFrame | null> => {
      if (!imagePath) return null;
      if (!hostRef.current) {
        hostRef.current = (async () => {
          const res = await registerResource(imagePath);
          if (!res) return null; // browser preview: no resource registry
          const host = await WgpuViewportHost.open("grade_preview");
          await host.command({ kind: "resize", width: size, height: size });
          await host.command({
            kind: "set_target",
            target: { kind: "image", resourceId: res.id },
          });
          return host;
        })();
      }
      const host = await hostRef.current;
      if (!host || !host.isOpen) return null;
      await host.command({ kind: "set_grade", doc });
      return host.renderFrame();
    },
    [imagePath, size],
  );
}
