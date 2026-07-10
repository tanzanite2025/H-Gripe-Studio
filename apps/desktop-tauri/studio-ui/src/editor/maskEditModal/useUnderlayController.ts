import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ViewportMaskOverlay, ViewportOverlayScene } from "../../bridge/viewport";
import { probeImageDims, registerResource } from "../../bridge/files";
import { type MaskDocument } from "../../contracts/maskDocument";
import { isBrushOp, isPathOp } from "../../contracts/maskOps";
import { useViewportUnderlay, type ViewportUnderlaySource } from "../../viewport/useViewportUnderlay";
import { IDENTITY_VIEW } from "../../viewport/view";
import { compileImageAdjustments } from "../imageCompile";
import {
  imageCompositeTarget,
  imageDocumentFrameHidden,
  imageDocumentNeedsComposite,
  layerCompositeTransform,
  withActiveLayerDraftTransform,
} from "../imageCompositeSource";
import { fromMaskDocument } from "../imageDocument";
import { composeTransforms, type TransformParams } from "../maskEdit";
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
  const needsCompositeSource = workspace === "image" && Boolean(imagePath) && imageDocumentNeedsComposite(document);
  const compositeDocument = useMemo(
    () => withActiveLayerDraftTransform(document, needsCompositeSource ? moveDraft : null),
    [document, needsCompositeSource, moveDraft],
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
    if (!needsCompositeSource) return plainSource;
    if (!compositeResourceId) return undefined;
    return imageCompositeTarget(compositeResourceId, compositeDocument, compositeDimensions);
  }, [
    needsCompositeSource,
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

  const imageTransform = useMemo(() => {
    if (workspace !== "image" || needsCompositeSource) return null;
    let transform: TransformParams | null = null;
    for (const layer of document.layers) {
      if (!layer.visible) continue;
      for (const op of layer.ops) {
        if (isPathOp(op) || isBrushOp(op) || op.type !== "transform" || op.disabled) continue;
        const params = { dx: op.dx ?? 0, dy: op.dy ?? 0, scale: op.scale ?? 1, rotate: op.rotate ?? 0 };
        transform = transform ? composeTransforms(transform, params) : params;
      }
    }
    if (moveDraft) {
      const base = transform ?? { dx: 0, dy: 0, scale: 1, rotate: 0 };
      transform = { ...base, dx: base.dx + moveDraft[0], dy: base.dy + moveDraft[1] };
    }
    return transform && (
      transform.dx !== 0
      || transform.dy !== 0
      || transform.scale !== 1
      || transform.rotate !== 0
    ) ? transform : null;
  }, [workspace, needsCompositeSource, document, moveDraft]);

  const activeCompositeTransform = useMemo(() => {
    if (workspace !== "image" || !needsCompositeSource) return null;
    return layerCompositeTransform(document.layers[document.active], moveDraft);
  }, [workspace, needsCompositeSource, document.layers, document.active, moveDraft]);

  const navigation = useCanvasNavigation(canvasRef, imageTransform, gestures);
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
    && !imageTransform
    && !cropRegion
    && !gradePreview
    && !entering
    && !closing;
  const underlayViewportView = imageTransform || cropRegion ? IDENTITY_VIEW : viewportView;
  const placementKey = useMemo(
    () => ({ view, imageTransform, cropRegion }),
    [view, imageTransform, cropRegion],
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
    imageTransform || cropRegion ? null : targetViewportView,
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
    needsCompositeSource,
    activeCompositeTransform,
    cropRegion,
    imageTransform,
    gradePreview,
    frameHidden,
  };
}
