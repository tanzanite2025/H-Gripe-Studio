import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ViewportMaskOverlay, ViewportOverlayScene } from "../../bridge/viewport";
import { probeImageDims, registerResource } from "../../bridge/files";
import { type ImageEditorDocument } from "../../contracts/imageEditorDocument";
import { useViewportUnderlay, type ViewportUnderlaySource } from "../../viewport/useViewportUnderlay";
import { IDENTITY_VIEW } from "../../viewport/view";
import { compileImageAdjustments } from "../imageCompile";
import {
  imageCompositeBackingPath,
  imageCompositeTarget,
} from "../imageCompositeSource";
import { fromImageEditorDocument } from "../imageDocument";
import type { PointerGestures } from "./pointer/types";
import { identitySceneFrame, stableImageSceneFrame, type SceneFrame, type StageSize } from "./sceneFrame";
import { canPresentImageEditorNativeSurfaceWithScopedHole } from "./imageEditorNativeSurfacePolicy";
import { useCanvasNavigation } from "./useCanvasNavigation";

interface UseUnderlayControllerArgs {
  workspace: "image" | "mask";
  imagePath: string | null | undefined;
  document: ImageEditorDocument;
  stageRef: RefObject<HTMLDivElement | null>;
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

function sameSceneFrame(a: SceneFrame | null, b: SceneFrame): boolean {
  return Boolean(a && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
}

export function useUnderlayController({
  workspace,
  imagePath,
  document,
  stageRef,
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
  const backingImagePath = useMemo(
    () => (workspace === "image" ? imageCompositeBackingPath(document, imagePath) : imagePath ?? null),
    [workspace, document, imagePath],
  );
  const plainSource = backingImagePath ?? undefined;
  const [sourceDimensions, setSourceDimensions] = useState<{ w: number; h: number } | null>(null);
  const compositeDimensions = document.canvas ?? sourceDimensions ?? fallbackDimensions;
  const [stageSize, setStageSize] = useState<StageSize | null>(null);
  // Image workspace rendering has a single path: the Rust per-layer
  // compositor. Every layer (the base included, since it carries an explicit
  // source_image op) states its own source and placement there.
  const compositeSource = workspace === "image" && Boolean(backingImagePath);
  const sceneDocument = document;
  const compositeDocument = sceneDocument;
  const [compositeResourceId, setCompositeResourceId] = useState<string | null>(null);
  const [stableSceneFrameState, setStableSceneFrameState] = useState<SceneFrame | null>(null);
  const stableSceneFrameKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const read = () => {
      const next = { w: Math.round(stage.clientWidth), h: Math.round(stage.clientHeight) };
      if (next.w <= 0 || next.h <= 0) return;
      setStageSize((current) => (
        current && current.w === next.w && current.h === next.h ? current : next
      ));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stageRef]);

  useEffect(() => {
    let cancelled = false;
    if (!backingImagePath) {
      setCompositeResourceId(null);
      setSourceDimensions(null);
      return;
    }
    setCompositeResourceId(null);
    setSourceDimensions(null);
    void (async () => {
      const resource = await registerResource(backingImagePath);
      if (cancelled) return;
      setCompositeResourceId(resource?.id ?? null);
      if (resource?.width && resource.height) {
        setSourceDimensions({ w: resource.width, h: resource.height });
        return;
      }
      const probed = await probeImageDims(backingImagePath);
      if (!cancelled) {
        setSourceDimensions(probed?.width && probed.height ? { w: probed.width, h: probed.height } : null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backingImagePath]);

  const sceneFrameKey = `${workspace}:${backingImagePath ?? ""}:${Math.round(compositeDimensions.w)}x${Math.round(compositeDimensions.h)}`;
  const previousSceneFrame = stableSceneFrameKeyRef.current === sceneFrameKey ? stableSceneFrameState : null;
  const sceneFrame = useMemo<SceneFrame>(() => {
    if (workspace !== "image") return identitySceneFrame(compositeDimensions);
    return stableImageSceneFrame(sceneDocument, compositeDimensions, stageSize, previousSceneFrame);
  }, [
    workspace,
    sceneDocument,
    compositeDimensions.w,
    compositeDimensions.h,
    stageSize?.w,
    stageSize?.h,
    previousSceneFrame?.x,
    previousSceneFrame?.y,
    previousSceneFrame?.w,
    previousSceneFrame?.h,
  ]);

  useEffect(() => {
    stableSceneFrameKeyRef.current = sceneFrameKey;
    setStableSceneFrameState((current) => (sameSceneFrame(current, sceneFrame) ? current : sceneFrame));
  }, [sceneFrameKey, sceneFrame.x, sceneFrame.y, sceneFrame.w, sceneFrame.h]);

  const source = useMemo<ViewportUnderlaySource | undefined>(() => {
    if (!compositeSource) return plainSource;
    if (!compositeResourceId) return undefined;
    return imageCompositeTarget(compositeResourceId, compositeDocument, compositeDimensions, sceneFrame);
  }, [
    compositeSource,
    plainSource,
    compositeResourceId,
    compositeDocument,
    compositeDimensions.w,
    compositeDimensions.h,
    sceneFrame.x,
    sceneFrame.y,
    sceneFrame.w,
    sceneFrame.h,
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

  const navigation = useCanvasNavigation(canvasRef, gestures);
  const { view, targetViewportView, viewportView } = navigation;
  const gradePreview = useMemo(() => {
    if (workspace !== "image") return null;
    const compiled = compileImageAdjustments(fromImageEditorDocument(document));
    return compiled && compiled.layers.some((layer) => layer.visible && layer.ops.length > 0) ? compiled : null;
  }, [workspace, document]);
  // Native surface presentation is allowed only after the image editor owns a
  // scoped stage hole. Until then, the viewport still renders through the host
  // boundary but must not punch transparent app/modal chrome.
  const nativeSurfacePresentationEnabled = canPresentImageEditorNativeSurfaceWithScopedHole({
    overlayOnly,
    view,
    cropRegion,
    gradePreview,
    entering,
    closing,
  });
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
    nativeSurfacePresentationEnabled,
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
    sceneFrame,
    stageSize,
    sourceDimensions,
    cropRegion,
    gradePreview,
  };
}
