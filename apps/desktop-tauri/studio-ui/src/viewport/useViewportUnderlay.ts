// Editor underlay via the viewport host (WGPU migration Phase 2, step 1).
// Instead of calling the thumbnail bridge directly, an editor opens a viewport,
// points it at the image *by resource reference*, and presents rendered frames.
// The frame is a data URL for now (Phase 1 CPU transport); when the transport
// becomes a WGPU texture the editors do not change — only this hook's
// presentation output does.

import { useEffect, useRef, useState } from "react";
import { registerResource } from "../bridge/files";
import type {
  ViewportBackend,
  ViewportKind,
  ViewportMaskOverlay,
  ViewportTarget,
} from "../bridge/viewport";
import { IDENTITY_VIEW, isIdentityView, type ViewportViewState } from "./view";
import { WgpuViewportHost } from "./WgpuViewportHost";

/**
 * What the underlay presents: an image file by path (registered as an image
 * resource on open) or a reference target the host resolves itself (e.g. an
 * `image_layer` of a registered layered asset).
 */
export type ViewportUnderlaySource = string | ViewportTarget;

/** Stable identity of a source, for effect dependencies. */
function sourceKey(source: ViewportUnderlaySource | undefined): string {
  if (source === undefined) return "none";
  if (typeof source === "string") return `path:${source}`;
  switch (source.kind) {
    case "image":
      return `image:${source.resourceId}`;
    case "image_layer":
      return `image_layer:${source.assetId}:${source.layerId}`;
    case "video_clip":
      return `video_clip:${source.timelineId}:${source.clipId}:${source.timeSec}`;
    case "video_frame":
      return `video_frame:${source.resourceId}:${source.timeSec}`;
    case "node_output":
      return `node_output:${source.nodeId}${source.outputPort ? `:${source.outputPort}` : ""}`;
  }
}

export interface ViewportUnderlay {
  /** Presented frame as an image source, or null (browser preview / error —
   * or the frame is on the native surface: see `presented`). */
  underlay: string | null;
  /** The frame is on the viewport's native surface window (WGPU surface swap
   * Phase S2): `underlay` is null and callers let the surface show through
   * instead of mounting an `<img>`. */
  presented: boolean;
  /** Full-frame pixel dimensions (the identity view's frame), or null until
   * the first frame arrives. Stable across zoom/pan re-renders so callers
   * can keep overlay geometry in one image-pixel space. */
  dims: { w: number; h: number } | null;
  /** The view window the presented frame was rendered for. Callers that
   * place the frame themselves (rather than filling their stage with it)
   * position it at this window's rect in the full frame. */
  frameView: ViewportViewState;
  /** Backend report of the last rendered frame (fallback contract). */
  backend: ViewportBackend | null;
  /** True once the attempt finished — with a frame, or without one (browser
   * preview / render error), letting callers stop showing a loading state. */
  settled: boolean;
}

/**
 * Open a `kind` viewport targeting `source` for the lifetime of the caller
 * and present its rendered frame. The viewport is created on demand (never at
 * startup), destroyed on unmount, and re-targeted when the source changes. A
 * path source registers as an image resource on open; a target source is set
 * as-is (the caller has already registered its referents, e.g. via
 * `registerLayeredAsset`). Outside Tauri the resource registry is unavailable
 * and a path source stays null — editors keep their checkerboard fallback.
 */
export function useViewportUnderlay(
  kind: ViewportKind,
  source: ViewportUnderlaySource | undefined,
  size = 1280,
  /** Presentation zoom/pan (viewport state): a change re-renders through the
   * open viewport's cached source proxy — the source is never re-decoded. */
  view: ViewportViewState = IDENTITY_VIEW,
  /** Mask overlay the host composites over frames (image_edit viewports):
   * the selection tint presents at the view window's detail instead of an
   * upscaled document-size canvas overlay. */
  maskOverlay: ViewportMaskOverlay | null = null,
): ViewportUnderlay {
  const [state, setState] = useState<ViewportUnderlay>({
    underlay: null,
    presented: false,
    dims: null,
    frameView: IDENTITY_VIEW,
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
  // The overlay last sent to the open host, to skip no-op commands.
  const sentOverlayRef = useRef<ViewportMaskOverlay | null>(null);
  const overlayRef = useRef(maskOverlay);
  overlayRef.current = maskOverlay;

  // The source object identity may change every render; key the open effect
  // on its stable identity and read the latest value through a ref.
  const key = sourceKey(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    setState({
      underlay: null,
      presented: false,
      dims: null,
      frameView: IDENTITY_VIEW,
      backend: null,
      settled: false,
    });
    const src = sourceRef.current;
    if (src === undefined) return;
    let cancelled = false;
    let host: WgpuViewportHost | null = null;
    const settle = () => {
      if (!cancelled) setState((s) => (s.settled ? s : { ...s, settled: true }));
    };

    (async () => {
      let target: ViewportTarget;
      if (typeof src === "string") {
        const res = await registerResource(src);
        if (!res || cancelled) {
          settle();
          return;
        }
        target = { kind: "image", resourceId: res.id };
      } else {
        target = src;
      }
      host = await WgpuViewportHost.open(kind);
      if (cancelled) {
        // The cleanup ran while `open` was in flight; it saw `host === null`,
        // so this side owns the destroy.
        void host.close();
        return;
      }
      await host.command({ kind: "resize", width: size, height: size });
      await host.command({ kind: "set_target", target });
      const initialView = viewRef.current;
      if (!isIdentityView(initialView)) {
        await host.command({ kind: "set_view", ...initialView });
      }
      const initialOverlay = overlayRef.current;
      if (initialOverlay) {
        await host.command({ kind: "set_mask_overlay", overlay: initialOverlay });
      }
      const frame = await host.renderFrame();
      if (cancelled) return;
      hostRef.current = host;
      sentViewRef.current = initialView;
      sentOverlayRef.current = initialOverlay;
      // A non-identity first frame is the view window; scale back to the
      // full-frame size so `dims` is view-independent.
      const zoom = Math.max(initialView.zoom, 1);
      setState({
        underlay: frame.presented ? null : frame.data_url,
        presented: frame.presented,
        dims: { w: Math.round(frame.width * zoom), h: Math.round(frame.height * zoom) },
        frameView: initialView,
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
  }, [kind, key, size]);

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
      // Keep `dims`: the view window changes size, the frame does not.
      setState((s) => ({
        ...s,
        underlay: frame.presented ? null : frame.data_url,
        presented: frame.presented,
        frameView: view,
        backend: frame.backend,
        settled: true,
      }));
    })().catch(() => {
      /* keep the previous frame */
    });
    return () => {
      cancelled = true;
    };
  }, [view]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !host.isOpen) return;
    if (maskOverlay === sentOverlayRef.current) return;
    let cancelled = false;
    sentOverlayRef.current = maskOverlay;
    (async () => {
      await host.command({ kind: "set_mask_overlay", overlay: maskOverlay });
      const frame = await host.renderFrame();
      if (cancelled || hostRef.current !== host) return;
      setState((s) => ({
        ...s,
        underlay: frame.presented ? null : frame.data_url,
        presented: frame.presented,
        backend: frame.backend,
        settled: true,
      }));
    })().catch(() => {
      /* keep the previous frame */
    });
    return () => {
      cancelled = true;
    };
  }, [maskOverlay]);

  return state;
}
