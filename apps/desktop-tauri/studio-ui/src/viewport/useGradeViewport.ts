// Grade preview via the viewport host (WGPU migration Phase 3). The grading
// dialog owns one grade_preview viewport for its target: opened lazily on the
// first preview request (never at mount), parameter updates flow as
// `set_grade` on viewport state — the target reference and transport stay
// untouched per slider change — and the viewport is destroyed on unmount or
// when the target path changes.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { tauriInvoke } from "../bridge/core";
import { registerResource } from "../bridge/files";
import {
  registerNodeOutput,
  type ViewportFrame,
  type ViewportPixels,
} from "../bridge/viewport";
import { IDENTITY_VIEW, type ViewportViewState } from "./view";
import { useViewportPlacement } from "./useViewportPlacement";
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

/** Wrap an async render so previews are latest-wins (GPU queue policy): at
 * most one call is in flight and one is queued. While a render runs, only the
 * newest request waits — a superseded queued request resolves `null` without
 * ever dispatching. Exported for tests; product code uses it through
 * [`useGradeViewport`]. */
export function latestWinsGate<A extends unknown[], T>(
  run: (...args: A) => Promise<T | null>,
): (...args: A) => Promise<T | null> {
  let inFlight = false;
  let queued: {
    args: A;
    resolve: (value: Promise<T | null> | null) => void;
  } | null = null;
  const gated = (...args: A): Promise<T | null> => {
    if (inFlight) {
      queued?.resolve(null); // superseded before dispatch
      return new Promise((resolve) => {
        queued = { args, resolve };
      });
    }
    inFlight = true;
    const result = run(...args);
    const settle = () => {
      inFlight = false;
      const next = queued;
      if (next) {
        queued = null;
        next.resolve(gated(...next.args));
      }
    };
    result.then(settle, settle);
    return result;
  };
  return gated;
}

interface OpenGradeViewport {
  host: WgpuViewportHost;
  ref: GradeViewportRef;
  /** Last view sent to the host, to skip no-op `set_view` commands. */
  view: ViewportViewState;
}

export interface GradeViewportApi {
  /** Apply `doc` to the target and render one graded frame of the
   * (optionally zoomed/panned) view window through the host.
   * `temporalDenoise` (`0..=1`, video targets only) blends graded frames
   * against the previous graded frame during continuous playback — the host
   * restarts the chain on a seek or source change. Preview renders are
   * latest-wins: at most one render is in flight and one is queued — a new
   * request supersedes the queued one, which resolves `null` without ever
   * reaching the host. Also resolves to `null` outside Tauri (browser
   * preview), where callers keep their in-webview mirror fallback. */
  renderGraded: (
    doc: unknown,
    view?: ViewportViewState,
    temporalDenoise?: number,
  ) => Promise<ViewportFrame | null>;
  /** Explicit pixel readback of the last rendered frame (scopes, colour
   * picking — surface swap Phase S4), never the per-frame path. `null`
   * before the first render or outside Tauri, where callers answer from
   * their mirror surface instead. */
  readPixels: () => Promise<ViewportPixels | null>;
}

/** The grading dialog's viewport boundary: see [`GradeViewportApi`]. */
export function useGradeViewport(
  target: GradeViewportTarget,
  size = 1280,
  /** Element the native surface window sits under (surface swap): when given,
   * placement is tracked for the host's lifetime and rendered frames present
   * on the surface — callers skip their `<img>` when `frame.presented`. */
  placementRef: RefObject<HTMLElement | null> | null = null,
): GradeViewportApi {
  const { imagePath, videoPath, videoTimestampSec = 0, nodeId } = target;
  const path = videoPath ?? imagePath ?? undefined;
  const isVideo = Boolean(videoPath);
  const nodeRef = isVideo ? undefined : (nodeId ?? undefined);
  const hostRef = useRef<Promise<OpenGradeViewport | null> | null>(null);
  const [openHost, setOpenHost] = useState<WgpuViewportHost | null>(null);
  const timeRef = useRef(videoTimestampSec);
  timeRef.current = videoTimestampSec;

  // Placement tracking (surface swap): inert without a placement ref — the
  // hook then never sends placement and frames stay on the PNG transport.
  const noPlacementRef = useRef<HTMLElement | null>(null);
  useViewportPlacement(openHost, placementRef ?? noPlacementRef);

  useEffect(() => {
    hostRef.current = null;
    setOpenHost(null);
    return () => {
      const pending = hostRef.current;
      hostRef.current = null;
      setOpenHost(null);
      void pending?.then((open) => open?.host.close());
    };
  }, [path, isVideo, nodeRef, size]);

  const renderOnce = useCallback(
    async (
      doc: unknown,
      view?: ViewportViewState,
      temporalDenoise?: number,
    ): Promise<ViewportFrame | null> => {
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
          setOpenHost(host);
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
              ? {
                  kind: "video_frame",
                  resourceId: open.ref.resourceId,
                  timeSec: timeRef.current,
                }
              : { kind: "image", resourceId: open.ref.resourceId },
      });
      await open.host.command({
        kind: "set_grade",
        doc,
        temporalDenoise: isVideo ? temporalDenoise : 0,
      });
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

  // Latest-wins gate over `renderOnce` (GPU queue policy): the host renders
  // one preview at a time; while it does, only the newest request waits — a
  // stacked slider drag cancels the queued render before it ever dispatches,
  // instead of piling renders up behind the command boundary.
  const renderGraded = useMemo(() => latestWinsGate(renderOnce), [renderOnce]);

  const readPixels = useCallback(async (): Promise<ViewportPixels | null> => {
    const open = await hostRef.current;
    if (!open || !open.host.isOpen) return null;
    return open.host.readPixels();
  }, []);

  return { renderGraded, readPixels };
}
