// Native surface placement tracking (WGPU surface swap Phase S1). A presenter
// that wants its viewport's pixels on a native surface reports where its
// element sits: this hook measures the element, sends `set_placement` on
// layout changes (rAF-throttled — resize, scroll, DPI), and hides the surface
// with `set_presented: false` on unmount. Placement is presentation-only
// plumbing: when the host reports fallback (browser preview, no adapter) the
// PNG transport stays authoritative and this hook is inert bookkeeping.

import { useEffect, type RefObject } from "react";
import type { ViewportPlacement } from "../bridge/viewport";
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

/**
 * Track `ref`'s element rect for the lifetime of `host` and keep the host's
 * native surface window placed under it. Re-measures on element resize,
 * window resize/scroll (capture phase, so scrolling any ancestor counts), and
 * rAF-throttles bursts so a drag-resize sends one placement per frame. On
 * cleanup the surface is hidden (`set_presented: false`), not destroyed —
 * destroy belongs to the host's `close()`.
 */
export function useViewportPlacement(
  host: WgpuViewportHost | null,
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!host || !host.isOpen || !el) return;
    let cancelled = false;
    let frame: number | null = null;
    let sent: ViewportPlacement | null = null;
    let inFlight = false;
    let pending = false;

    const send = async () => {
      if (cancelled || inFlight) {
        pending = pending || inFlight;
        return;
      }
      const placement = measurePlacement(el, window.devicePixelRatio || 1);
      if (samePlacement(sent, placement)) return;
      inFlight = true;
      try {
        await host.command({ kind: "set_placement", placement });
        sent = placement;
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
      if (cancelled || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        void send();
      });
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();

    return () => {
      cancelled = true;
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
  }, [host, ref]);
}
