// Editor underlay via the viewport host (WGPU migration Phase 2, step 1).
// Instead of calling the thumbnail bridge directly, an editor opens a viewport,
// points it at the image *by resource reference*, and presents rendered frames.
// The frame is a data URL for now (Phase 1 CPU transport); when the transport
// becomes a WGPU texture the editors do not change — only this hook's
// presentation output does.

import { useEffect, useRef, useState, type RefObject } from "react";
import { registerResource } from "../bridge/files";
import type {
  ViewportBackend,
  ViewportKind,
  ViewportMaskOverlay,
  ViewportOverlayScene,
  ViewportTarget,
} from "../bridge/viewport";
import { IDENTITY_VIEW, isIdentityView, type ViewportViewState } from "./view";
import { useViewportPlacement } from "./useViewportPlacement";
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
  /** The open viewport host, for explicit host calls that the presented
   * frame cannot answer — pixel readback (`readPixels`, surface swap Phase
   * S4). Null until open and after close. */
  host: WgpuViewportHost | null;
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
  /** Element the native surface window sits under (surface swap): when given,
   * placement is tracked for the host's lifetime and presented frames skip
   * the PNG transport — callers keep their DOM overlays above the hole. */
  placementRef: RefObject<HTMLElement | null> | null = null,
  /** Present on the native surface only while true — false for states the
   * surface cannot represent (rotated view, transparency preview): the
   * surface hides and frames fall back to the PNG transport. */
  presentEnabled = true,
  /** Vector overlay (selection outlines) the host strokes over frames
   * (image_edit viewports): marching ants present at the view window's
   * detail — one screen pixel wide at any zoom — instead of on a
   * document-size canvas. */
  overlayScene: ViewportOverlayScene | null = null,
  /** Re-measures the surface placement on change (CSS transforms move the
   * placement element without firing the resize observer): callers whose
   * stage zooms/pans with a transform pass their view state here so the
   * surface window follows it. */
  placementKey: unknown = undefined,
): ViewportUnderlay {
  const [state, setState] = useState<Omit<ViewportUnderlay, "host">>({
    underlay: null,
    presented: false,
    dims: null,
    frameView: IDENTITY_VIEW,
    backend: null,
    settled: false,
  });
  const hostRef = useRef<WgpuViewportHost | null>(null);
  const [openHost, setOpenHost] = useState<WgpuViewportHost | null>(null);
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
  const sentSceneRef = useRef<ViewportOverlayScene | null>(null);
  const sceneRef = useRef(overlayScene);
  sceneRef.current = overlayScene;
  // One re-render in flight per host, with the latest request coalesced
  // behind it. A zoom/pan drag or a brush stroke changes state per input
  // event; issuing one overlapping `set_view`/`set_mask_overlay` +
  // `render_frame` chain per change floods the IPC channel (on Windows every
  // response is a PostMessage to the main thread — enough backlog fills the
  // message queue). Instead the newest request replaces the queued one and
  // sends when the in-flight chain finishes.
  const renderInFlightRef = useRef(false);
  const queuedRenderRef = useRef<(() => Promise<void>) | null>(null);

  const runCoalesced = (host: WgpuViewportHost, send: () => Promise<void>) => {
    if (renderInFlightRef.current) {
      queuedRenderRef.current = send;
      return;
    }
    renderInFlightRef.current = true;
    void (async () => {
      let next: (() => Promise<void>) | null = send;
      while (next && hostRef.current === host && host.isOpen) {
        try {
          await next();
        } catch {
          /* keep the previous frame */
        }
        next = queuedRenderRef.current;
        queuedRenderRef.current = null;
      }
      renderInFlightRef.current = false;
    })();
  };

  // The source object identity may change every render; key the open effect
  // on its stable identity and read the latest value through a ref.
  const key = sourceKey(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Placement tracking (surface swap): inert without a placement ref — the
  // hook then never sends placement and frames stay on the PNG transport.
  // The first frame renders before the placement lands (the surface window
  // is created lazily by the first `set_placement`), so it always rides the
  // PNG transport; when the report says the surface took the placement and
  // the current frame is not on it yet, one re-render moves it over.
  const noPlacementRef = useRef<HTMLElement | null>(null);
  const framePresentedRef = useRef(false);
  const sentPresentEnabledRef = useRef(true);
  const presentEnabledRef = useRef(presentEnabled);
  presentEnabledRef.current = presentEnabled;
  const onPlaced = (report: { presented: boolean }) => {
    const host = hostRef.current;
    if (!report.presented || framePresentedRef.current) return;
    if (!host || !host.isOpen || !presentEnabledRef.current) return;
    runCoalesced(host, async () => {
      const frame = await host.renderFrame();
      if (hostRef.current !== host) return;
      framePresentedRef.current = frame.presented;
      setState((s) => ({
        ...s,
        underlay: frame.presented ? null : frame.data_url,
        presented: frame.presented,
        backend: frame.backend,
        settled: true,
      }));
    });
  };
  useViewportPlacement(
    openHost,
    placementRef ?? noPlacementRef,
    presentEnabled,
    onPlaced,
    placementKey,
  );

  useEffect(() => {
    framePresentedRef.current = false;
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
      const initialScene = sceneRef.current;
      if (initialScene) {
        await host.command({ kind: "set_overlay_scene", scene: initialScene });
      }
      const frame = await host.renderFrame();
      if (cancelled) return;
      hostRef.current = host;
      setOpenHost(host);
      sentViewRef.current = initialView;
      sentOverlayRef.current = initialOverlay;
      sentSceneRef.current = initialScene;
      sentPresentEnabledRef.current = presentEnabledRef.current;
      // A non-identity first frame is the view window; scale back to the
      // full-frame size so `dims` is view-independent.
      const zoom = Math.max(initialView.zoom, 1);
      framePresentedRef.current = frame.presented;
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
      setOpenHost(null);
      void host?.close();
    };
  }, [kind, key, size]);

  // A presentability flip re-renders through the open host: disabling hides
  // the surface first (so the frame falls back to the PNG transport rather
  // than presenting into a hidden window); enabling just re-renders — the
  // placement resend above re-shows the surface for it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !host.isOpen) return;
    if (presentEnabled === sentPresentEnabledRef.current) return;
    let cancelled = false;
    sentPresentEnabledRef.current = presentEnabled;
    runCoalesced(host, async () => {
      if (!presentEnabled) {
        await host.command({ kind: "set_presented", presented: false });
      }
      const frame = await host.renderFrame();
      if (cancelled || hostRef.current !== host) return;
      framePresentedRef.current = frame.presented;
      setState((s) => ({
        ...s,
        underlay: frame.presented ? null : frame.data_url,
        presented: frame.presented,
        backend: frame.backend,
        settled: true,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [presentEnabled]);

  useEffect(() => {
    const host = hostRef.current;
    const sent = sentViewRef.current;
    if (!host || !host.isOpen) return;
    if (view.zoom === sent.zoom && view.panX === sent.panX && view.panY === sent.panY) return;
    if (isIdentityView(view) && isIdentityView(sent)) return;
    let cancelled = false;
    sentViewRef.current = view;
    runCoalesced(host, async () => {
      await host.command({ kind: "set_view", ...view });
      const frame = await host.renderFrame();
      if (cancelled || hostRef.current !== host) return;
      // Keep `dims`: the view window changes size, the frame does not.
      framePresentedRef.current = frame.presented;
      setState((s) => ({
        ...s,
        underlay: frame.presented ? null : frame.data_url,
        presented: frame.presented,
        frameView: view,
        backend: frame.backend,
        settled: true,
      }));
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
    runCoalesced(host, async () => {
      await host.command({ kind: "set_mask_overlay", overlay: maskOverlay });
      const frame = await host.renderFrame();
      if (cancelled || hostRef.current !== host) return;
      framePresentedRef.current = frame.presented;
      setState((s) => ({
        ...s,
        underlay: frame.presented ? null : frame.data_url,
        presented: frame.presented,
        backend: frame.backend,
        settled: true,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [maskOverlay]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !host.isOpen) return;
    if (overlayScene === sentSceneRef.current) return;
    let cancelled = false;
    sentSceneRef.current = overlayScene;
    runCoalesced(host, async () => {
      await host.command({ kind: "set_overlay_scene", scene: overlayScene });
      const frame = await host.renderFrame();
      if (cancelled || hostRef.current !== host) return;
      framePresentedRef.current = frame.presented;
      setState((s) => ({
        ...s,
        underlay: frame.presented ? null : frame.data_url,
        presented: frame.presented,
        backend: frame.backend,
        settled: true,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [overlayScene]);

  return { ...state, host: openHost };
}
