// Editor underlay via the viewport host (WGPU migration Phase 2, step 1).
// Instead of calling the thumbnail bridge directly, an editor opens a viewport,
// points it at the image *by resource reference*, and presents rendered frames.
// The frame is a data URL for now (Phase 1 CPU transport); when the transport
// becomes a WGPU texture the editors do not change — only this hook's
// presentation output does.

import { useEffect, useRef, useState } from "react";
import { registerResource } from "../bridge/files";
import type { ViewportBackend, ViewportKind } from "../bridge/viewport";
import { IDENTITY_VIEW, isIdentityView, type ViewportViewState } from "./view";
import { WgpuViewportHost } from "./WgpuViewportHost";

export interface ViewportUnderlay {
  /** Presented frame as an image source, or null (browser preview / error). */
  underlay: string | null;
  /** Frame pixel dimensions, or null until the first frame arrives. */
  dims: { w: number; h: number } | null;
  /** Backend report of the last rendered frame (fallback contract). */
  backend: ViewportBackend | null;
  /** True once the attempt finished — with a frame, or without one (browser
   * preview / render error), letting callers stop showing a loading state. */
  settled: boolean;
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
  /** Presentation zoom/pan (viewport state): a change re-renders through the
   * open viewport's cached source proxy — the source is never re-decoded. */
  view: ViewportViewState = IDENTITY_VIEW,
): ViewportUnderlay {
  const [state, setState] = useState<ViewportUnderlay>({
    underlay: null,
    dims: null,
    backend: null,
    settled: false,
  });
  const hostRef = useRef<WgpuViewportHost | null>(null);
  // The view last sent to the open host, to skip no-op `set_view` commands.
  const sentViewRef = useRef<ViewportViewState>(IDENTITY_VIEW);
  // Latest requested view, so a host opened after a view change (e.g. the
  // caller flipped targets while zoomed) renders that view, not identity.
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    setState({ underlay: null, dims: null, backend: null, settled: false });
    if (!imagePath) return;
    let cancelled = false;
    let host: WgpuViewportHost | null = null;
    const settle = () => {
      if (!cancelled) setState((s) => (s.settled ? s : { ...s, settled: true }));
    };

    (async () => {
      const res = await registerResource(imagePath);
      if (!res || cancelled) {
        settle();
        return;
      }
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
      const initialView = viewRef.current;
      if (!isIdentityView(initialView)) {
        await host.command({ kind: "set_view", ...initialView });
      }
      const frame = await host.renderFrame();
      if (cancelled) return;
      hostRef.current = host;
      sentViewRef.current = initialView;
      setState({
        underlay: frame.data_url,
        dims: { w: frame.width, h: frame.height },
        backend: frame.backend,
        settled: true,
      });
    })().catch(() => {
      // Keep nulls; editors fall back to their checkerboard.
      settle();
    });

    return () => {
      cancelled = true;
      hostRef.current = null;
      void host?.close();
    };
  }, [kind, imagePath, size]);

  useEffect(() => {
    const host = hostRef.current;
    const sent = sentViewRef.current;
    if (!host || !host.isOpen) return;
    if (view.zoom === sent.zoom && view.panX === sent.panX && view.panY === sent.panY) return;
    if (isIdentityView(view) && isIdentityView(sent)) return;
    let cancelled = false;
    sentViewRef.current = view;
    (async () => {
      await host.command({ kind: "set_view", ...view });
      const frame = await host.renderFrame();
      if (cancelled || hostRef.current !== host) return;
      setState({
        underlay: frame.data_url,
        dims: { w: frame.width, h: frame.height },
        backend: frame.backend,
        settled: true,
      });
    })().catch(() => {
      /* keep the previous frame */
    });
    return () => {
      cancelled = true;
    };
  }, [view]);

  return state;
}
