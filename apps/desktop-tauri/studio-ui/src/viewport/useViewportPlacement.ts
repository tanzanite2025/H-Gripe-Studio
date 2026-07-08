// Native surface placement tracking (WGPU surface swap Phase S1). A presenter
// that wants its viewport's pixels on a native surface reports where its
// element sits: this hook measures the element, sends `set_placement` on
// layout changes (rAF-throttled — resize, scroll, DPI), and hides the surface
// with `set_presented: false` on unmount. Placement is presentation-only
// plumbing: when the host reports fallback (browser preview, no adapter) the
// PNG transport stays authoritative and this hook is inert bookkeeping.

import { useEffect, useRef, type RefObject } from "react";
import type { ViewportPlacement, ViewportPlacementReport } from "../bridge/viewport";
import type { WgpuViewportHost } from "./WgpuViewportHost";

/** The element's placement in the webview: border-box rect in logical CSS
 * pixels relative to the viewport origin, plus the device pixel ratio. */
export function measurePlacement(el: Element, dpr: number): ViewportPlacement {
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, dpr };
}

function samePlacement(a: ViewportPlacement | null, b: ViewportPlacement): boolean {
  return (
    a !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.dpr === b.dpr
  );
}

function isPermanentSurfaceFallback(reason: string | undefined): boolean {
  const text = reason?.toLowerCase() ?? "";
  return (
    text.includes("shared adapter") ||
    text.includes("not supported") ||
    text.includes("without a presentation surface") ||
    text.includes("viewport-surface feature disabled") ||
    text.includes("windows-only") ||
    text.includes("surface creation failed") ||
    text.includes("surface window class registration failed")
  );
}

/**
 * Track `ref`'s element rect for the lifetime of `host` and keep the host's
 * native surface window placed under it. Re-measures on element resize,
 * window resize/scroll (capture phase, so scrolling any ancestor counts), and
 * rAF-throttles bursts so a drag-resize sends one placement per frame. On
 * cleanup the surface is hidden (`set_presented: false`), not destroyed —
 * destroy belongs to the host's `close()`.
 *
 * `enabled: false` hides the surface and stops tracking without unmounting
 * the presenter — for states the surface cannot represent (a rotated view,
 * transparency preview). Re-enabling resends the placement, which re-shows.
 *
 * `onPlaced` receives the host's placement report (fallback contract):
 * callers that presented their first frame before the surface window existed
 * re-render on `presented: true` so the frame moves off the PNG transport.
 *
 * `remeasureKey` re-measures on change without re-mounting the tracking. CSS
 * transforms move the element without firing the resize observer, so a caller
 * whose element sits under a transform (canvas zoom/pan) passes its view
 * state here to keep the surface window under the transformed rect.
 */
export function useViewportPlacement(
  host: WgpuViewportHost | null,
  ref: RefObject<HTMLElement | null>,
  enabled = true,
  onPlaced?: (report: ViewportPlacementReport) => void,
  remeasureKey?: unknown,
): void {
  const onPlacedRef = useRef(onPlaced);
  onPlacedRef.current = onPlaced;
  const scheduleRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    scheduleRef.current?.();
  }, [remeasureKey]);
  useEffect(() => {
    const el = ref.current;
    if (!host || !host.isOpen || !el) return;
    if (!enabled) {
      host.command({ kind: "set_presented", presented: false }).catch(() => {
        /* the viewport may already be destroyed */
      });
      return;
    }
    let cancelled = false;
    let frame: number | null = null;
    let sent: ViewportPlacement | null = null;
    let inFlight = false;
    let pending = false;
    let disabledByFallback = false;

    const send = async () => {
      if (cancelled || disabledByFallback || inFlight) {
        pending = pending || inFlight;
        return;
      }
      const placement = measurePlacement(el, window.devicePixelRatio || 1);
      if (samePlacement(sent, placement)) return;
      inFlight = true;
      try {
        const report = await host.place(placement);
        sent = placement;
        if (!cancelled) {
          onPlacedRef.current?.(report);
          if (!report.presented && isPermanentSurfaceFallback(report.fallback_reason)) {
            disabledByFallback = true;
            scheduleRef.current = null;
          }
        }
      } catch {
        /* keep the previous placement; the PNG transport still presents */
      } finally {
        inFlight = false;
        if (pending && !cancelled) {
          pending = false;
          schedule();
        }
      }
    };

    const schedule = () => {
      if (cancelled || disabledByFallback || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        void send();
      });
    };

    scheduleRef.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();

    return () => {
      cancelled = true;
      scheduleRef.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (host.isOpen) {
        host.command({ kind: "set_presented", presented: false }).catch(() => {
          /* the viewport may already be destroyed */
        });
      }
    };
  }, [host, ref, enabled]);
}
