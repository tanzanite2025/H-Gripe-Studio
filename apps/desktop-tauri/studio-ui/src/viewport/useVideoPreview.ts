// Program-monitor presentation via the viewport host (WGPU migration Phase 4
// on the CPU transport). The monitor owns one video_preview viewport, opened
// lazily on the first frame request (never at mount) and destroyed on
// unmount. Scrubbing is coalesced webview-side: at most one render is in
// flight, a newer request replaces the queued one (latest-wins), and stale
// results are dropped — the Rust playback engine coalesces the same way on
// its decode thread, so a slider burst decodes only the newest position.

import { useCallback, useEffect, useRef, useState } from "react";
import { registerResource } from "../bridge/files";
import type { ViewportBackend, ViewportFrame } from "../bridge/viewport";
import type { PreviewFrameTarget } from "../production/previewFrame";
import { WgpuViewportHost } from "./WgpuViewportHost";

export interface VideoPreviewState {
  /** Latest rendered frame as a data URL, or null (gap / not yet rendered). */
  frame: string | null;
  backend: ViewportBackend | null;
  /** True while a frame request is in flight or queued. */
  pending: boolean;
  error: string | null;
}

interface MonitorState {
  host: WgpuViewportHost;
  /** Registered resource id per media path, so scrubbing re-registers nothing. */
  resources: Map<string, string>;
}

/**
 * Present timeline frames through a `video_preview` viewport. Call
 * `showFrame(target)` with the resolved playhead media (null for a gap);
 * the latest call wins. Outside Tauri the state stays empty (`frame: null`,
 * `settled` via `pending: false`) — the monitor renders its placeholder.
 */
export function useVideoPreview(size = 1280): {
  state: VideoPreviewState;
  showFrame: (target: PreviewFrameTarget | null) => void;
} {
  const [state, setState] = useState<VideoPreviewState>({
    frame: null,
    backend: null,
    pending: false,
    error: null,
  });
  const monitorRef = useRef<Promise<MonitorState | null> | null>(null);
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const queuedRef = useRef<PreviewFrameTarget | null | undefined>(undefined);

  useEffect(() => {
    return () => {
      const pending = monitorRef.current;
      monitorRef.current = null;
      void pending?.then((m) => m?.host.close());
    };
  }, []);

  const renderTarget = useCallback(
    async (target: PreviewFrameTarget | null): Promise<void> => {
      const seq = ++seqRef.current;
      if (target === null) {
        setState((s) => ({ ...s, frame: null, pending: false, error: null }));
        return;
      }
      if (!monitorRef.current) {
        monitorRef.current = (async () => {
          const host = await WgpuViewportHost.open("video_preview");
          await host.command({ kind: "resize", width: size, height: size });
          return { host, resources: new Map<string, string>() };
        })().catch(() => null);
      }
      const monitor = await monitorRef.current;
      if (!monitor || !monitor.host.isOpen || seqRef.current !== seq) return;
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
      await monitor.host.command({
        kind: "set_target",
        target:
          target.kind === "video"
            ? { kind: "video_frame", resourceId, timeSec: target.sourceTimeSec }
            : { kind: "image", resourceId },
      });
      const frame: ViewportFrame = await monitor.host.renderFrame();
      if (seqRef.current !== seq) return; // stale: a newer seek finished after us
      setState({ frame: frame.data_url, backend: frame.backend, pending: false, error: null });
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
    (target: PreviewFrameTarget | null) => {
      // Latest-wins queue of depth one: a burst of scrub positions keeps only
      // the newest; the single in-flight render finishes and picks it up.
      queuedRef.current = target;
      setState((s) => (s.pending ? s : { ...s, pending: true }));
      if (!inFlightRef.current) {
        inFlightRef.current = true;
        void pump();
      }
    },
    [pump],
  );

  return { state, showFrame };
}
