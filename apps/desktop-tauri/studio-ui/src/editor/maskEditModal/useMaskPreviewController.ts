import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ViewportMaskOverlay } from "../../bridge/viewport";
import type { MaskDocument } from "../../types/production";
import { PreviewLane } from "../../runtime/previewLane";
import { applyOp, buildProxyMask, isPreviewableOp, ProxyLayerCache, type ProxyMask } from "../maskMorphology";

interface Dimensions {
  w: number;
  h: number;
}

interface UseMaskPreviewControllerArgs {
  toolId: string;
  amount: number;
  document: MaskDocument;
  initialDimensions: Dimensions;
}

export interface MaskPreviewController {
  quickMask: boolean;
  setQuickMask: Dispatch<SetStateAction<boolean>>;
  quickProxy: ProxyMask | null;
  preview: ProxyMask | null;
  previewing: boolean;
  viewportMaskOverlay: ViewportMaskOverlay | null;
  setDimensions: (dimensions: Dimensions) => void;
}

export function useMaskPreviewController({
  toolId,
  amount,
  document,
  initialDimensions,
}: UseMaskPreviewControllerArgs): MaskPreviewController {
  const [quickMask, setQuickMask] = useState(false);
  const [quickProxy, setQuickProxy] = useState<ProxyMask | null>(null);
  const [preview, setPreview] = useState<ProxyMask | null>(null);
  const [dimensions, setStoredDimensions] = useState(initialDimensions);
  const previewLane = useRef(new PreviewLane());
  const proxyCache = useRef(new ProxyLayerCache());

  const setDimensions = useCallback((nextDimensions: Dimensions) => {
    setStoredDimensions((current) => (
      current.w === nextDimensions.w && current.h === nextDimensions.h
        ? current
        : nextDimensions
    ));
  }, []);

  const previewing = isPreviewableOp(toolId) && preview != null;
  const viewportMaskOverlay = useMemo<ViewportMaskOverlay | null>(() => {
    const proxy = previewing && preview ? preview : quickMask && quickProxy ? quickProxy : null;
    if (!proxy) return null;
    return previewing && preview
      ? { w: proxy.w, h: proxy.h, data: proxy.data, rgb: [86, 168, 255], alpha: 0.55 }
      : { w: proxy.w, h: proxy.h, data: proxy.data, rgb: [224, 32, 32], alpha: 0.5, invert: true };
  }, [previewing, preview, quickMask, quickProxy]);

  useEffect(() => {
    if (!isPreviewableOp(toolId)) {
      setPreview(null);
      previewLane.current.cancel();
      return;
    }
    let disposed = false;
    void previewLane.current
      .run<ProxyMask | null>(async (signal) => {
        const { mask, scale } = buildProxyMask(document, dimensions, { cache: proxyCache.current });
        if (signal.cancelled) return null;
        return applyOp(mask, toolId, Math.max(0, Math.round(amount * scale)));
      })
      .then((outcome) => {
        if (!disposed && outcome.status === "applied" && outcome.value) setPreview(outcome.value);
      });
    return () => {
      disposed = true;
    };
  }, [toolId, amount, document, dimensions]);

  useEffect(() => {
    if (!quickMask) {
      setQuickProxy(null);
      return;
    }
    setQuickProxy(buildProxyMask(document, dimensions, { cache: proxyCache.current }).mask);
  }, [quickMask, document, dimensions]);

  return {
    quickMask,
    setQuickMask,
    quickProxy,
    preview,
    previewing,
    viewportMaskOverlay,
    setDimensions,
  };
}
