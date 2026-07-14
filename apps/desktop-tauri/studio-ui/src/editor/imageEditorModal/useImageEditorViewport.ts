import { useMemo, useRef, type RefObject } from "react";
import type {
  ImageLayerScenePresentation,
  ViewportMaskOverlay,
  ViewportOverlayScene,
} from "../../bridge/viewport";
import { type ImageEditorDocument } from "../../contracts/imageEditorDocument";
import {
  useViewportUnderlay,
  type ViewportUnderlaySource,
} from "../../viewport/useViewportUnderlay";
import { IDENTITY_VIEW } from "../../viewport/view";
import { compileImageAdjustments } from "../imageCompile";
import { imageCompositeDocumentKey, imageCompositeTarget } from "../imageCompositeTarget";
import { imageCompositeBackingPath } from "../imageLayerSource";
import { fromImageEditorDocument } from "../imageDocument";
import type { PointerGestures } from "./pointer/types";
import { imageEditorCoordinateSpaces } from "./imageEditorCoordinateSpaces";
import type { SceneFrame } from "./sceneFrame";
import { fitFrameInStage, type StageSize } from "./stageProjection";
import { canPresentImageEditorNativeSurfaceWithScopedHole } from "./imageEditorNativeSurfacePolicy";
import type { LayerMovePreviewTransaction } from "./layerMovePreviewStore";
import { useCanvasNavigation, type CanvasNavigationLayout } from "./useCanvasNavigation";
import { useObservedElementSize } from "./useObservedElementSize";
import { useRegisteredImageResource } from "./useRegisteredImageResource";

interface UseImageEditorViewportArgs {
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
  selectedLayerId: string | null;
  layerMovePreview: LayerMovePreviewTransaction | null;
  fallbackDimensions: { w: number; h: number };
  emptyDimensions: { w: number; h: number };
}

export function useImageEditorViewport({
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
  selectedLayerId,
  layerMovePreview,
  fallbackDimensions,
  emptyDimensions,
}: UseImageEditorViewportArgs) {
  const backingImagePath = useMemo(
    () => (workspace === "image" ? imageCompositeBackingPath(document, imagePath) : imagePath ?? null),
    [workspace, document, imagePath],
  );
  const plainSource = backingImagePath ?? undefined;
  const {
    resourceId: compositeResourceId,
    dimensions: sourceDimensions,
  } = useRegisteredImageResource(backingImagePath);
  const compositeDimensions = document.canvas ?? sourceDimensions ?? fallbackDimensions;
  const stageSize: StageSize | null = useObservedElementSize(stageRef);
  // Image workspace rendering has a single path: the Rust per-layer
  // compositor. Every layer (the base included, since it carries an explicit
  // source_image op) states its own source and placement there.
  const compositeSource = workspace === "image" && Boolean(backingImagePath);
  const coordinateSpaces = useMemo(
    () => imageEditorCoordinateSpaces(compositeDimensions),
    [
    compositeDimensions.w,
    compositeDimensions.h,
    ],
  );
  // Document interaction stays in the compact document frame. The retained
  // compositor scene spans the stable logical pasteboard so transformed layer
  // pixels remain addressable outside the document without per-layer canvases.
  const renderFrame = coordinateSpaces.renderFrame;
  const logicalPasteboard = workspace === "image"
    ? coordinateSpaces.logicalPasteboard
    : coordinateSpaces.renderFrame;
  const compositeSceneFrame = workspace === "image"
    ? logicalPasteboard
    : renderFrame;

  const documentKey = useMemo(
    () => imageCompositeDocumentKey(document, compositeDimensions, compositeSceneFrame),
    [
      document,
      compositeDimensions.w,
      compositeDimensions.h,
      compositeSceneFrame.x,
      compositeSceneFrame.y,
      compositeSceneFrame.w,
      compositeSceneFrame.h,
    ],
  );
  const imageLayerPresentation = useMemo<ImageLayerScenePresentation | null>(() => {
    if (workspace !== "image" || !selectedLayerId) return null;
    const preview = layerMovePreview?.selectedLayerId === selectedLayerId
      && (
        layerMovePreview.phase === "dragging"
        || layerMovePreview.baseDocumentKey === documentKey
      )
      ? layerMovePreview
      : null;
    const delta = preview?.delta ?? null;
    return {
      selectedLayerId,
      transactionId: preview?.transactionId ?? `selection:${selectedLayerId}`,
      baseDocumentKey: preview?.baseDocumentKey ?? documentKey,
      sequence: preview?.sequence ?? 0,
      moveDraft: delta ? { dx: delta[0], dy: delta[1] } : null,
    };
  }, [
    workspace,
    selectedLayerId,
    documentKey,
    layerMovePreview?.transactionId,
    layerMovePreview?.baseDocumentKey,
    layerMovePreview?.selectedLayerId,
    layerMovePreview?.phase,
    layerMovePreview?.sequence,
    layerMovePreview?.delta?.[0],
    layerMovePreview?.delta?.[1],
  ]);

  const source = useMemo<ViewportUnderlaySource | undefined>(() => {
    if (!compositeSource) return plainSource;
    if (!compositeResourceId) return undefined;
    return imageCompositeTarget(compositeResourceId, document, compositeDimensions, compositeSceneFrame);
  }, [
    compositeSource,
    plainSource,
    compositeResourceId,
    document,
    compositeDimensions.w,
    compositeDimensions.h,
    compositeSceneFrame.x,
    compositeSceneFrame.y,
    compositeSceneFrame.w,
    compositeSceneFrame.h,
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

  const navigationFitFrame = useMemo<SceneFrame>(() => (
    cropRegion
      ? {
          x: cropRegion[0],
          y: cropRegion[1],
          w: Math.max(1, cropRegion[2] - cropRegion[0]),
          h: Math.max(1, cropRegion[3] - cropRegion[1]),
        }
      : renderFrame
  ), [
    cropRegion,
    renderFrame.x,
    renderFrame.y,
    renderFrame.w,
    renderFrame.h,
  ]);
  const navigationLayout = useMemo<CanvasNavigationLayout | null>(() => {
    if (!stageSize) return null;
    const fitted = fitFrameInStage(stageSize, navigationFitFrame.w / navigationFitFrame.h);
    if (!fitted) return null;
    return {
      // The canvas remains the full document child when a crop window is
      // fitted. Zoom anchoring therefore uses its document-sized CSS base.
      baseW: fitted.width * (renderFrame.w / navigationFitFrame.w),
      baseH: fitted.height * (renderFrame.h / navigationFitFrame.h),
      stageW: stageSize.w,
      stageH: stageSize.h,
      viewportWorldFrame: compositeSceneFrame,
      viewportFitFrame: navigationFitFrame,
      revision: [
        renderFrame.x,
        renderFrame.y,
        renderFrame.w,
        renderFrame.h,
        logicalPasteboard.x,
        logicalPasteboard.y,
        logicalPasteboard.w,
        logicalPasteboard.h,
        navigationFitFrame.x,
        navigationFitFrame.y,
        navigationFitFrame.w,
        navigationFitFrame.h,
      ].join(":"),
    };
  }, [
    stageSize?.w,
    stageSize?.h,
    renderFrame.x,
    renderFrame.y,
    renderFrame.w,
    renderFrame.h,
    logicalPasteboard.x,
    logicalPasteboard.y,
    logicalPasteboard.w,
    logicalPasteboard.h,
    compositeSceneFrame.x,
    compositeSceneFrame.y,
    compositeSceneFrame.w,
    compositeSceneFrame.h,
    navigationFitFrame.x,
    navigationFitFrame.y,
    navigationFitFrame.w,
    navigationFitFrame.h,
  ]);

  const navigation = useCanvasNavigation(canvasRef, gestures, navigationLayout);
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
  const hostViewportView = cropRegion ? IDENTITY_VIEW : viewportView;
  const placementKey = useMemo(
    () => ({ view, cropRegion }),
    [view, cropRegion],
  );
  const nativeSurfacePlacementAnchorRef = useRef<HTMLDivElement | null>(null);
  const viewport = useViewportUnderlay(
    "image_edit",
    source,
    1280,
    hostViewportView,
    viewportMaskOverlay,
    nativeSurfacePlacementAnchorRef,
    nativeSurfacePresentationEnabled,
    viewportOverlayScene,
    placementKey,
    cropRegion ? null : targetViewportView,
    imageLayerPresentation,
  );
  const documentDimensions = document.canvas ?? sourceDimensions ?? viewport.dims;
  const dimensions = documentDimensions ?? emptyDimensions;

  return {
    navigation,
    viewport,
    nativeSurfacePlacementAnchorRef,
    viewportFrameUrl: viewport.underlay,
    nativeSurfacePresented: viewport.presented,
    frameView: viewport.frameView,
    documentDimensions,
    dimensions,
    renderFrame,
    logicalPasteboard,
    stageSize,
    sourceDimensions,
    cropRegion,
    gradePreview,
    documentKey,
  };
}
