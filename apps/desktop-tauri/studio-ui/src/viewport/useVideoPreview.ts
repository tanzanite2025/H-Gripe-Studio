// Program-monitor presentation via the viewport host (WGPU migration Phase 4
// on the CPU transport). The monitor owns one video_preview viewport, opened
// lazily on the first frame request (never at mount) and destroyed on
// unmount. Scrubbing is coalesced webview-side: at most one render is in
// flight, a newer request replaces the queued one (latest-wins), and stale
// results are dropped — the Rust playback engine coalesces the same way on
// its decode thread, so a slider burst decodes only the newest position.
//
// Frames render through the same grade document model as the grade preview:
// a clip's stored grade doc is applied viewport-side to the displayed frame,
// so the monitor shows graded output without a second color pipeline.

import { useCallback, useEffect, useRef, useState } from "react";
import { registerResource } from "../bridge/files";
import type {
  ViewportBackend,
  ViewportFrame,
  ViewportOverlayScene,
  ViewportTarget,
} from "../bridge/viewport";
import type { PreviewFrameTarget } from "../production/previewFrame";
import { IDENTITY_VIEW, type ViewportViewState } from "./view";
import { WgpuViewportHost } from "./WgpuViewportHost";

export interface VideoPreviewState {
  /** Latest rendered frame as a data URL, or null (gap / not yet rendered —
   * or the frame is on the native surface: see `presented`). */
  frame: string | null;
  /** The frame is on the viewport's native surface window (WGPU surface swap
   * Phase S3): `frame` is null and the monitor lets the surface show through
   * instead of mounting an `<img>`. */
  presented: boolean;
  backend: ViewportBackend | null;
  /** True while a frame request is in flight or queued. */
  pending: boolean;
  error: string | null;
}

interface MonitorState {
  host: WgpuViewportHost;
  /** The surface window is hidden for a gap frame; re-shown before the next
   * rendered frame. */
  hidden: boolean;
  /** Registered resource id per media path, so scrubbing re-registers nothing. */
  resources: Map<string, string>;
  /** Grade doc (JSON string) currently set on the viewport, to skip no-op sets. */
  gradeDoc: string | null;
  /** View last sent to the viewport, to skip no-op `set_view` commands. */
  view: ViewportViewState;
  /** Overlay scene last sent to the viewport (by reference), to skip no-op sets. */
  overlayScene: ViewportOverlayScene | null;
}

/**
 * What a frame request presents: a `video_clip` reference target when the
 * timeline is registered with the host (resolution happens Rust-side), or
 * the webview-resolved playhead media as a fallback.
 */
export type VideoPreviewTarget =
  | PreviewFrameTarget
  | Extract<ViewportTarget, { kind: "video_clip" }>;

/** A frame request: the playhead target plus the clip's grade doc. */
export interface VideoPreviewRequest {
  target: VideoPreviewTarget;
  /** The clip's stored grade doc (JSON string), applied to the frame. */
  gradeDoc: string | null;
  /** Monitor zoom/pan (viewport state); identity when omitted. */
  view?: ViewportViewState;
  /** Vector overlay stroked over the frame host-side (safe-area guides).
   * Callers keep a stable reference while unchanged; omitted means none. */
  overlayScene?: ViewportOverlayScene | null;
}

/** Parse a stored grade doc (JSON string) for the viewport; bad JSON clears. */
function parseGradeDoc(gradeDoc: string | null): unknown | null {
  if (!gradeDoc) return null;
  try {
    return JSON.parse(gradeDoc) as unknown;
  } catch {
    return null;
  }
}

/**
 * Present timeline frames through a `video_preview` viewport. Call
 * `showFrame(request)` with the resolved playhead media (null for a gap);
 * the latest call wins. Outside Tauri the state stays empty (`frame: null`,
 * `settled` via `pending: false`) — the monitor renders its placeholder.
 */
export function useVideoPreview(size = 1280): {
  state: VideoPreviewState;
  showFrame: (request: VideoPreviewRequest | null) => void;
  /** The monitor's viewport host once open (for native surface placement). */
  host: WgpuViewportHost | null;
} {
  const [state, setState] = useState<VideoPreviewState>({
    frame: null,
    presented: false,
    backend: null,
    pending: false,
    error: null,
  });
  const [host, setHost] = useState<WgpuViewportHost | null>(null);
  const monitorRef = useRef<Promise<MonitorState | null> | null>(null);
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const queuedRef = useRef<VideoPreviewRequest | null | undefined>(undefined);

  useEffect(() => {
    return () => {
      const pending = monitorRef.current;
      monitorRef.current = null;
      void pending?.then((m) => m?.host.close());
    };
  }, []);

  const renderTarget = useCallback(
    async (request: VideoPreviewRequest | null): Promise<void> => {
      const seq = ++seqRef.current;
      if (request === null) {
        // A gap frame hides the surface window (it would otherwise keep
        // showing the previous clip's frame under the placeholder).
        const monitor = await monitorRef.current;
        if (monitor?.host.isOpen && !monitor.hidden) {
          monitor.hidden = true;
          await monitor.host.command({ kind: "set_presented", presented: false }).catch(() => {});
        }
        if (seqRef.current !== seq) return;
        setState((s) => ({ ...s, frame: null, presented: false, pending: false, error: null }));
        return;
      }
      const { target, gradeDoc, view = IDENTITY_VIEW, overlayScene = null } = request;
      if (!monitorRef.current) {
        monitorRef.current = (async () => {
          const host = await WgpuViewportHost.open("video_preview");
          await host.command({ kind: "resize", width: size, height: size });
          setHost(host);
          return {
            host,
            hidden: false,
            resources: new Map<string, string>(),
            gradeDoc: null,
            view: IDENTITY_VIEW,
            overlayScene: null,
          };
        })().catch(() => null);
      }
      const monitor = await monitorRef.current;
      if (!monitor || !monitor.host.isOpen || seqRef.current !== seq) return;
      let viewportTarget: ViewportTarget;
      if (target.kind === "video_clip") {
        // Reference target: the host resolves the clip through its timeline
        // registry; nothing to register per frame.
        viewportTarget = target;
      } else {
        let resourceId = monitor.resources.get(target.path);
        if (!resourceId) {
          const res = await registerResource(target.path);
          if (!res) {
            // Browser preview: no resource registry; leave the placeholder.
            setState((s) => ({ ...s, pending: false }));
            return;
          }
          resourceId = res.id;
          monitor.resources.set(target.path, resourceId);
        }
        if (seqRef.current !== seq) return;
        viewportTarget =
          target.kind === "video"
            ? { kind: "video_frame", resourceId, timeSec: target.sourceTimeSec }
            : { kind: "image", resourceId };
      }
      await monitor.host.command({ kind: "set_target", target: viewportTarget });
      if (gradeDoc !== monitor.gradeDoc) {
        await monitor.host.command({ kind: "set_grade", doc: parseGradeDoc(gradeDoc) });
        monitor.gradeDoc = gradeDoc;
      }
      if (
        view.zoom !== monitor.view.zoom ||
        view.panX !== monitor.view.panX ||
        view.panY !== monitor.view.panY
      ) {
        await monitor.host.command({ kind: "set_view", ...view });
        monitor.view = view;
      }
      if (overlayScene !== monitor.overlayScene) {
        await monitor.host.command({ kind: "set_overlay_scene", scene: overlayScene });
        monitor.overlayScene = overlayScene;
      }
      if (monitor.hidden) {
        // Re-show the surface hidden by a gap frame before presenting on it.
        monitor.hidden = false;
        await monitor.host.command({ kind: "set_presented", presented: true });
      }
      const frame: ViewportFrame = await monitor.host.renderFrame();
      if (seqRef.current !== seq) return; // stale: a newer seek finished after us
      setState({
        frame: frame.presented ? null : frame.data_url,
        presented: frame.presented,
        backend: frame.backend,
        pending: false,
        error: null,
      });
    },
    [size],
  );

  const pump = useCallback(async (): Promise<void> => {
    while (queuedRef.current !== undefined) {
      const target = queuedRef.current;
      queuedRef.current = undefined;
      try {
        await renderTarget(target);
      } catch (err) {
        setState((s) => ({ ...s, pending: false, error: String(err) }));
      }
    }
    inFlightRef.current = false;
  }, [renderTarget]);

  const showFrame = useCallback(
    (request: VideoPreviewRequest | null) => {
      // Latest-wins queue of depth one: a burst of scrub positions keeps only
      // the newest; the single in-flight render finishes and picks it up.
      queuedRef.current = request;
      setState((s) => (s.pending ? s : { ...s, pending: true }));
      if (!inFlightRef.current) {
        inFlightRef.current = true;
        void pump();
      }
    },
    [pump],
  );

  return { state, showFrame, host };
}
