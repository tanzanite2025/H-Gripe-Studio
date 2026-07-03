// Editor underlay via the viewport host (WGPU migration Phase 2, step 1).
// Instead of calling the thumbnail bridge directly, an editor opens a viewport,
// points it at the image *by resource reference*, and presents rendered frames.
// The frame is a data URL for now (Phase 1 CPU transport); when the transport
// becomes a WGPU texture the editors do not change — only this hook's
// presentation output does.

import { useEffect, useState } from "react";
import { registerResource } from "../bridge/files";
import type { ViewportBackend, ViewportKind } from "../bridge/viewport";
import { WgpuViewportHost } from "./WgpuViewportHost";

export interface ViewportUnderlay {
  /** Presented frame as an image source, or null (browser preview / error). */
  underlay: string | null;
  /** Frame pixel dimensions, or null until the first frame arrives. */
  dims: { w: number; h: number } | null;
  /** Backend report of the last rendered frame (fallback contract). */
  backend: ViewportBackend | null;
}

/**
 * Open a `kind` viewport targeting `imagePath` for the lifetime of the caller
 * and present its rendered frame. The viewport is created on demand (never at
 * startup), destroyed on unmount, and re-targeted when the path changes.
 * Outside Tauri the resource registry is unavailable and everything stays
 * null — editors keep their checkerboard fallback.
 */
export function useViewportUnderlay(
  kind: ViewportKind,
  imagePath: string | undefined,
  size = 1280,
): ViewportUnderlay {
  const [state, setState] = useState<ViewportUnderlay>({
    underlay: null,
    dims: null,
    backend: null,
  });

  useEffect(() => {
    if (!imagePath) return;
    let cancelled = false;
    let host: WgpuViewportHost | null = null;

    (async () => {
      const res = await registerResource(imagePath);
      if (!res || cancelled) return;
      host = await WgpuViewportHost.open(kind);
      if (cancelled) {
        // The cleanup ran while `open` was in flight; it saw `host === null`,
        // so this side owns the destroy.
        void host.close();
        return;
      }
      await host.command({ kind: "resize", width: size, height: size });
      await host.command({
        kind: "set_target",
        target: { kind: "image", resourceId: res.id },
      });
      const frame = await host.renderFrame();
      if (cancelled) return;
      setState({
        underlay: frame.data_url,
        dims: { w: frame.width, h: frame.height },
        backend: frame.backend,
      });
    })().catch(() => {
      /* keep nulls; editors fall back to their checkerboard */
    });

    return () => {
      cancelled = true;
      void host?.close();
    };
  }, [kind, imagePath, size]);

  return state;
}
