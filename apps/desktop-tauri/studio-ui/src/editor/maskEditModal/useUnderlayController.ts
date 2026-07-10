import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ViewportMaskOverlay, ViewportOverlayScene } from "../../bridge/viewport";
import { probeImageDims, registerResource } from "../../bridge/files";
import { type MaskDocument } from "../../contracts/maskDocument";
import { useViewportUnderlay, type ViewportUnderlaySource } from "../../viewport/useViewportUnderlay";
import { IDENTITY_VIEW } from "../../viewport/view";
import { compileImageAdjustments } from "../imageCompile";
import {
  imageCompositeTarget,
  imageDocumentFrameHidden,
  layerCompositeTransform,
  withActiveLayerDraftTransform,
} from "../imageCompositeSource";
import { fromMaskDocument } from "../imageDocument";
import type { PointerGestures } from "./pointer/types";
import { useCanvasNavigation } from "./useCanvasNavigation";

interface UseUnderlayControllerArgs {
  workspace: "image" | "mask";
  imagePath: string | null | undefined;
  document: MaskDocument;
  moveDraft: [number, number] | null;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  gestures: PointerGestures;
  overlayOnly: boolean;
  entering: boolean;
  closing: boolean;
  viewportMaskOverlay: ViewportMaskOverlay | null;
  viewportOverlayScene: ViewportOverlayScene | null;
  fallbackDimensions: { w: number; h: number };
  emptyDimensions: { w: number; h: number };
}

export function useUnderlayController({
  workspace,
  imagePath,
  document,
  moveDraft,
  canvasRef,
  gestures,
  overlayOnly,
  entering,
  closing,
  viewportMaskOverlay,
  viewportOverlayScene,
  fallbackDimensions,
  emptyDimensions,
}: UseUnderlayControllerArgs) {
  const plainSource = imagePath ?? undefined;
  const [sourceDimensions, setSourceDimensions] = useState<{ w: number; h: number } | null>(null);
  const compositeDimensions = document.canvas ?? sourceDimensions ?? fallbackDimensions;
  // Image workspace rendering has a single path: the Rust per-layer
  // compositor. Every layer (the base included, since it carries an explicit
  // source_image op) states its own source and placement there.
  const compositeSource = workspace === "image" && Boolean(imagePath);
  const compositeDocument = useMemo(
    () => withActiveLayerDraftTransform(document, compositeSource ? moveDraft : null),
    [document, compositeSource, moveDraft],
  );
  const [compositeResourceId, setCompositeResourceId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!imagePath) {
      setCompositeResourceId(null);
      setSourceDimensions(null);
      return;
    }
    setCompositeResourceId(null);
    setSourceDimensions(null);
    void (async () => {
      const resource = await registerResource(imagePath);
      if (cancelled) return;
      setCompositeResourceId(resource?.id ?? null);
      if (resource?.width && resource.height) {
        setSourceDimensions({ w: resource.width, h: resource.height });
        return;
      }
      const probed = await probeImageDims(imagePath);
      if (!cancelled) {
        setSourceDimensions(probed?.width && probed.height ? { w: probed.width, h: probed.height } : null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imagePath]);

  const source = useMemo<ViewportUnderlaySource | undefined>(() => {
    if (!compositeSource) return plainSource;
    if (!compositeResourceId) return undefined;
    return imageCompositeTarget(compositeResourceId, compositeDocument, compositeDimensions);
  }, [
    compositeSource,
    plainSource,
    compositeResourceId,
    compositeDocument,
    compositeDimensions.w,
    compositeDimensions.h,
  ]);

  const cropRegion = useMemo(() => {
    if (workspace !== "image") return null;
    let last: [number, number, number, number] | null = null;
    for (const layer of document.layers) {
      if (!layer.visible) continue;
      for (const op of layer.ops) {
        if (op.type === "crop" && op.region && op.region.length >= 4) {
          last = [op.region[0], op.region[1], op.region[2], op.region[3]];
        }
      }
    }
    return last;
  }, [workspace, document]);

  const activeCompositeTransform = useMemo(() => {
    if (workspace !== "image") return null;
    return layerCompositeTransform(document.layers[document.active], moveDraft);
  }, [workspace, document.layers, document.active, moveDraft]);

  const navigation = useCanvasNavigation(canvasRef, gestures);
  const { view, targetViewportView, viewportView } = navigation;
  const gradePreview = useMemo(() => {
    if (workspace !== "image") return null;
    const compiled = compileImageAdjustments(fromMaskDocument(document));
    return compiled && compiled.layers.some((layer) => layer.visible && layer.ops.length > 0) ? compiled : null;
  }, [workspace, document]);
  const frameHidden = useMemo(
    () => workspace === "image" && imageDocumentFrameHidden(document),
    [workspace, document],
  );
  // Native surface presentation (surface swap Phase S2) is disabled here: the
  // surface sits under the webview, but the app root and modal chrome paint
  // opaque backgrounds over its rect, so a presented frame is invisible — the
  // stage goes blank right after the PNG frame is dropped. Frames stay on the
  // PNG transport until the see-through hole works end to end.
  const SURFACE_HOLE_SUPPORTED = false;
  const presentEnabled =
    SURFACE_HOLE_SUPPORTED
    && !overlayOnly
    && !frameHidden
    && !view.rotate
    && !cropRegion
    && !gradePreview
    && !entering
    && !closing;
  const underlayViewportView = cropRegion ? IDENTITY_VIEW : viewportView;
  const placementKey = useMemo(
    () => ({ view, cropRegion }),
    [view, cropRegion],
  );
  const underlayAnchorRef = useRef<HTMLDivElement | null>(null);
  const viewport = useViewportUnderlay(
    "image_edit",
    source,
    1280,
    underlayViewportView,
    viewportMaskOverlay,
    underlayAnchorRef,
    presentEnabled,
    viewportOverlayScene,
    placementKey,
    cropRegion ? null : targetViewportView,
  );
  const documentDimensions = document.canvas ?? sourceDimensions ?? viewport.dims;
  const dimensions = documentDimensions ?? emptyDimensions;

  return {
    navigation,
    viewport,
    underlayAnchorRef,
    underlay: viewport.underlay,
    presented: viewport.presented,
    frameView: viewport.frameView,
    documentDimensions,
    dimensions,
    sourceDimensions,
    activeCompositeTransform,
    cropRegion,
    gradePreview,
    frameHidden,
  };
}
