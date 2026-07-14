import { useEffect, useRef, useState, type RefObject } from "react";

import { registerResource } from "../bridge/files";
import type {
  ImageLayerScenePresentation,
  PresentedImageLayerScene,
  ViewportBackend,
  ViewportImageScene,
  ViewportKind,
  ViewportMaskOverlay,
  ViewportOverlayScene,
  ViewportSelectedLayerFrame,
  ViewportTarget,
} from "../bridge/viewport";
import { IDENTITY_VIEW, type ViewportViewState } from "./view";
import { measurePlacement, useViewportPlacement } from "./useViewportPlacement";
import {
  viewportUnderlaySourceHostKey,
  viewportUnderlaySourceImageScene,
  viewportUnderlaySourceSceneKey,
  viewportUnderlaySourceTargetKey,
  type ViewportUnderlaySource,
} from "./viewportTargetIdentity";
import { WgpuViewportHost } from "./WgpuViewportHost";

export {
  viewportUnderlaySourceSceneKey,
  viewportUnderlaySourceTargetKey,
} from "./viewportTargetIdentity";
export type { ViewportUnderlaySource } from "./viewportTargetIdentity";

export interface ViewportUnderlay {
  underlay: string | null;
  presented: boolean;
  /** Full-frame dimensions, independent of the current view window. */
  dims: { w: number; h: number } | null;
  frameView: ViewportViewState;
  backend: ViewportBackend | null;
  settled: boolean;
  /** True only when the displayed frame belongs to the current target. */
  targetSettled: boolean;
  renderedTargetKey: string | null;
  sceneSettled: boolean;
  renderedSceneKey: string | null;
  presentedImageLayerScene: PresentedImageLayerScene | null;
  selectedLayerFrame: ViewportSelectedLayerFrame | null;
  host: WgpuViewportHost | null;
}

interface ViewportSyncSnapshot {
  revision: number;
  source: ViewportUnderlaySource;
  targetKey: string;
  sceneKey: string | null;
  imageScene: ViewportImageScene | null;
  size: number;
  view: ViewportViewState;
  maskOverlay: ViewportMaskOverlay | null;
  overlayScene: ViewportOverlayScene | null;
  imageLayerPresentation: ImageLayerScenePresentation | null;
  presentEnabled: boolean;
}

interface ViewportSyncController {
  host: WgpuViewportHost;
  closed: boolean;
  requestedRevision: number;
  appliedRevision: number;
  finishedRenderRevision: number;
  syncing: boolean;
  rendering: boolean;
  lastAppliedSnapshot: ViewportSyncSnapshot | null;
  liveRequestedRevision: number;
  liveCompletedRevision: number;
  liveRunning: boolean;
}

async function frameDecoded(frame: { presented: boolean; data_url: string }): Promise<void> {
  if (frame.presented || !frame.data_url || typeof Image === "undefined") return;
  const image = new Image();
  image.src = frame.data_url;
  if (typeof image.decode === "function") await image.decode();
}

function sameView(a: ViewportViewState, b: ViewportViewState): boolean {
  return a.zoom === b.zoom && a.panX === b.panX && a.panY === b.panY;
}

function sameImageLayerPresentation(
  a: ImageLayerScenePresentation | null,
  b: ImageLayerScenePresentation | null,
): boolean {
  return (
    a === b
    || (
      a !== null
      && b !== null
      && a.selectedLayerId === b.selectedLayerId
      && a.transactionId === b.transactionId
      && a.baseDocumentKey === b.baseDocumentKey
      && a.sequence === b.sequence
      && (
        a.moveDraft === b.moveDraft
        || (
          a.moveDraft !== null
          && b.moveDraft !== null
          && a.moveDraft.dx === b.moveDraft.dx
          && a.moveDraft.dy === b.moveDraft.dy
        )
      )
    )
  );
}

function sameImageLayerTransaction(
  a: ImageLayerScenePresentation | null,
  b: ImageLayerScenePresentation,
): boolean {
  return (
    a !== null
    && a.selectedLayerId === b.selectedLayerId
    && a.transactionId === b.transactionId
    && a.baseDocumentKey === b.baseDocumentKey
  );
}

function frameMatchesImageLayerPresentation(
  frame: {
    documentKey: string | null;
    transactionId: string | null;
    sequence: number | null;
    selectedLayerFrame: ViewportSelectedLayerFrame | null;
  },
  imageScene: ViewportImageScene | null,
  presentation: ImageLayerScenePresentation | null,
): boolean {
  if (imageScene && frame.documentKey !== imageScene.documentKey) return false;
  if (!presentation) return true;
  return (
    frame.documentKey === presentation.baseDocumentKey
    && frame.transactionId === presentation.transactionId
    && frame.sequence === presentation.sequence
    && (
      frame.selectedLayerFrame === null
      || frame.selectedLayerFrame.layerId === presentation.selectedLayerId
    )
  );
}

function presentedImageLayerScene(frame: {
  documentKey: string | null;
  transactionId: string | null;
  sequence: number | null;
}): PresentedImageLayerScene | null {
  if (frame.documentKey === null && frame.transactionId === null && frame.sequence === null) {
    return null;
  }
  return {
    documentKey: frame.documentKey,
    transactionId: frame.transactionId,
    sequence: frame.sequence,
  };
}

function isSupersededRenderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("render superseded");
}

/**
 * Own one viewport host and synchronize every desired state change through a
 * per-host controller. Commands are never represented as replaceable queued
 * closures: target, size, view and overlays are all reconciled from one latest
 * snapshot, and a setter is recorded as sent only after it succeeds.
 */
export function useViewportUnderlay(
  kind: ViewportKind,
  source: ViewportUnderlaySource | undefined,
  size = 1280,
  view: ViewportViewState = IDENTITY_VIEW,
  maskOverlay: ViewportMaskOverlay | null = null,
  placementRef: RefObject<HTMLElement | null> | null = null,
  presentEnabled = true,
  overlayScene: ViewportOverlayScene | null = null,
  placementKey: unknown = undefined,
  liveView: ViewportViewState | null = null,
  imageLayerPresentation: ImageLayerScenePresentation | null = null,
): ViewportUnderlay {
  const [state, setState] = useState<Omit<ViewportUnderlay, "host">>({
    underlay: null,
    presented: false,
    dims: null,
    frameView: IDENTITY_VIEW,
    backend: null,
    settled: false,
    targetSettled: false,
    renderedTargetKey: null,
    sceneSettled: false,
    renderedSceneKey: null,
    presentedImageLayerScene: null,
    selectedLayerFrame: null,
  });
  const hostRef = useRef<WgpuViewportHost | null>(null);
  const [openHost, setOpenHost] = useState<WgpuViewportHost | null>(null);
  const controllerRef = useRef<ViewportSyncController | null>(null);

  const sentSizeRef = useRef<number | null>(null);
  const sentTargetKeyRef = useRef<string | null>(null);
  const sentImageSceneKeyRef = useRef<string | null>(null);
  const sentViewRef = useRef<ViewportViewState>(IDENTITY_VIEW);
  const sentOverlayRef = useRef<ViewportMaskOverlay | null>(null);
  const sentSceneRef = useRef<ViewportOverlayScene | null>(null);
  const sentImageLayerPresentationRef = useRef<ImageLayerScenePresentation | null>(null);
  const sentPresentEnabledRef = useRef<boolean | null>(null);

  const hostKey = viewportUnderlaySourceHostKey(source);
  const targetKey = viewportUnderlaySourceTargetKey(source);
  const sceneKey = viewportUnderlaySourceSceneKey(source);
  const imageScene = viewportUnderlaySourceImageScene(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  const sceneKeyRef = useRef(sceneKey);
  sceneKeyRef.current = sceneKey;
  const imageSceneRef = useRef(imageScene);
  imageSceneRef.current = imageScene;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const viewRef = useRef(view);
  viewRef.current = view;
  const overlayRef = useRef(maskOverlay);
  overlayRef.current = maskOverlay;
  const sceneRef = useRef(overlayScene);
  sceneRef.current = overlayScene;
  const imageLayerPresentationRef = useRef(imageLayerPresentation);
  imageLayerPresentationRef.current = imageLayerPresentation;
  const presentEnabledRef = useRef(presentEnabled);
  presentEnabledRef.current = presentEnabled;
  const liveViewRef = useRef(liveView);
  liveViewRef.current = liveView;
  const framePresentedRef = useRef(false);

  function controllerIsCurrent(controller: ViewportSyncController): boolean {
    return (
      !controller.closed
      && controllerRef.current === controller
      && hostRef.current === controller.host
      && controller.host.isOpen
    );
  }

  function failCurrentSync(controller: ViewportSyncController, revision: number): void {
    if (!controllerIsCurrent(controller) || controller.requestedRevision !== revision) return;
    setState((previous) => {
      const preservesCompleteTarget = previous.renderedTargetKey === targetKeyRef.current
        && (previous.presented || previous.underlay !== null);
      if (preservesCompleteTarget) {
        framePresentedRef.current = previous.presented;
        return {
          ...previous,
          settled: true,
          targetSettled: true,
          sceneSettled: previous.renderedSceneKey === sceneKeyRef.current,
        };
      }
      framePresentedRef.current = false;
      return {
        ...previous,
        underlay: null,
        presented: false,
        backend: null,
        settled: true,
        targetSettled: false,
        renderedTargetKey: null,
        sceneSettled: false,
        renderedSceneKey: null,
        presentedImageLayerScene: null,
        selectedLayerFrame: null,
      };
    });
  }

  function maybeStartLive(controller: ViewportSyncController): void {
    if (!controllerIsCurrent(controller) || controller.liveRunning) return;
    if (controller.syncing || controller.appliedRevision < controller.requestedRevision) return;
    if (controller.liveCompletedRevision >= controller.liveRequestedRevision) return;
    controller.liveRunning = true;
    void (async () => {
      try {
        while (
          controllerIsCurrent(controller)
          && !controller.syncing
          && controller.appliedRevision >= controller.requestedRevision
          && controller.liveCompletedRevision < controller.liveRequestedRevision
        ) {
          const revision = controller.liveRequestedRevision;
          const requestedView = liveViewRef.current;
          const requestedTargetKey = targetKeyRef.current;
          if (
            !requestedView
            || !framePresentedRef.current
            || !presentEnabledRef.current
            || sentTargetKeyRef.current !== requestedTargetKey
          ) {
            controller.liveCompletedRevision = revision;
            continue;
          }
          const took = await controller.host.presentView(requestedView);
          controller.liveCompletedRevision = revision;
          if (
            !took
            || !controllerIsCurrent(controller)
            || controller.liveRequestedRevision !== revision
            || targetKeyRef.current !== requestedTargetKey
            || !framePresentedRef.current
          ) {
            continue;
          }
          setState((previous) => (
            previous.targetSettled && previous.renderedTargetKey === requestedTargetKey
              ? { ...previous, frameView: requestedView }
              : previous
          ));
        }
      } finally {
        controller.liveRunning = false;
        if (
          controllerIsCurrent(controller)
          && !controller.syncing
          && controller.appliedRevision >= controller.requestedRevision
          && controller.liveCompletedRevision < controller.liveRequestedRevision
        ) {
          maybeStartLive(controller);
        }
      }
    })();
  }

  function maybeStartRender(controller: ViewportSyncController): void {
    if (!controllerIsCurrent(controller) || controller.rendering || controller.syncing) return;
    if (controller.appliedRevision < controller.requestedRevision) return;
    const snapshot = controller.lastAppliedSnapshot;
    if (!snapshot || snapshot.revision <= controller.finishedRenderRevision) return;
    controller.rendering = true;
    void (async () => {
      try {
        const frame = await controller.host.renderFrame();
        await frameDecoded(frame);
        controller.finishedRenderRevision = Math.max(
          controller.finishedRenderRevision,
          snapshot.revision,
        );
        if (
          !controllerIsCurrent(controller)
          || controller.requestedRevision !== snapshot.revision
          || controller.appliedRevision !== snapshot.revision
          || targetKeyRef.current !== snapshot.targetKey
        ) {
          return;
        }
        if (!frameMatchesImageLayerPresentation(
          frame,
          snapshot.imageScene,
          snapshot.imageLayerPresentation,
        )) {
          failCurrentSync(controller, snapshot.revision);
          return;
        }
        const zoom = Math.max(snapshot.view.zoom, 1);
        framePresentedRef.current = frame.presented;
        setState({
          underlay: frame.presented ? null : frame.data_url,
          presented: frame.presented,
          dims: { w: Math.round(frame.width * zoom), h: Math.round(frame.height * zoom) },
          frameView: snapshot.view,
          backend: frame.backend,
          settled: true,
          targetSettled: true,
          renderedTargetKey: snapshot.targetKey,
          sceneSettled: true,
          renderedSceneKey: snapshot.sceneKey,
          presentedImageLayerScene: presentedImageLayerScene(frame),
          selectedLayerFrame: frame.selectedLayerFrame,
        });
      } catch (error) {
        controller.finishedRenderRevision = Math.max(
          controller.finishedRenderRevision,
          snapshot.revision,
        );
        if (!isSupersededRenderError(error)) {
          failCurrentSync(controller, snapshot.revision);
        }
      } finally {
        controller.rendering = false;
        if (controllerIsCurrent(controller)) {
          maybeStartRender(controller);
          maybeStartLive(controller);
        }
      }
    })();
  }

  function drainSync(controller: ViewportSyncController): void {
    if (!controllerIsCurrent(controller) || controller.syncing) return;
    if (controller.appliedRevision >= controller.requestedRevision) {
      maybeStartRender(controller);
      maybeStartLive(controller);
      return;
    }
    controller.syncing = true;
    void (async () => {
      try {
        while (
          controllerIsCurrent(controller)
          && controller.appliedRevision < controller.requestedRevision
        ) {
          const revision = controller.requestedRevision;
          const requestedSource = sourceRef.current;
          if (requestedSource === undefined) {
            controller.appliedRevision = revision;
            controller.finishedRenderRevision = revision;
            failCurrentSync(controller, revision);
            continue;
          }
          const snapshot: ViewportSyncSnapshot = {
            revision,
            source: requestedSource,
            targetKey: targetKeyRef.current,
            sceneKey: sceneKeyRef.current,
            imageScene: imageSceneRef.current,
            size: sizeRef.current,
            view: viewRef.current,
            maskOverlay: overlayRef.current,
            overlayScene: sceneRef.current,
            imageLayerPresentation: imageLayerPresentationRef.current,
            presentEnabled: presentEnabledRef.current,
          };
          try {
            let target: ViewportTarget | null = null;
            if (sentTargetKeyRef.current !== snapshot.targetKey) {
              if (typeof snapshot.source === "string") {
                const resource = await registerResource(snapshot.source);
                if (!resource) throw new Error("viewport source registration unavailable");
                target = { kind: "image", resourceId: resource.id };
              } else {
                target = snapshot.source;
              }
            }
            if (!controllerIsCurrent(controller)) return;
            if (controller.requestedRevision !== revision) continue;

            const pixelIdentityChanging = (
              sentSizeRef.current !== snapshot.size
              || sentTargetKeyRef.current !== snapshot.targetKey
            );
            if (pixelIdentityChanging) {
              framePresentedRef.current = false;
              setState((previous) => ({
                ...previous,
                underlay: null,
                presented: false,
                backend: null,
                settled: false,
                targetSettled: false,
                renderedTargetKey: null,
                sceneSettled: false,
                renderedSceneKey: null,
                presentedImageLayerScene: null,
                selectedLayerFrame: null,
              }));
            }

            if (!snapshot.presentEnabled && sentPresentEnabledRef.current !== false) {
              await controller.host.command({ kind: "set_presented", presented: false });
              sentPresentEnabledRef.current = false;
            }
            if (sentSizeRef.current !== snapshot.size) {
              await controller.host.command({
                kind: "resize",
                width: snapshot.size,
                height: snapshot.size,
              });
              sentSizeRef.current = snapshot.size;
            }
            if (sentTargetKeyRef.current !== snapshot.targetKey) {
              if (!target) throw new Error("viewport target was not resolved");
              await controller.host.command({ kind: "set_target", target });
              sentTargetKeyRef.current = snapshot.targetKey;
              // Image-composite set_target already carries and builds this
              // exact initial scene. Only later same-resource revisions use
              // set_image_scene.
              sentImageSceneKeyRef.current = snapshot.imageScene
                ? snapshot.sceneKey
                : null;
              sentImageLayerPresentationRef.current = null;
            }
            if (
              snapshot.imageScene
              && sentImageSceneKeyRef.current !== snapshot.sceneKey
            ) {
              await controller.host.command({
                kind: "set_image_scene",
                scene: snapshot.imageScene,
              });
              sentImageSceneKeyRef.current = snapshot.sceneKey;
              sentImageLayerPresentationRef.current = null;
            }
            if (!sameView(sentViewRef.current, snapshot.view)) {
              await controller.host.command({ kind: "set_view", ...snapshot.view });
              sentViewRef.current = snapshot.view;
            }
            if (sentOverlayRef.current !== snapshot.maskOverlay) {
              await controller.host.command({
                kind: "set_mask_overlay",
                overlay: snapshot.maskOverlay,
              });
              sentOverlayRef.current = snapshot.maskOverlay;
            }
            if (sentSceneRef.current !== snapshot.overlayScene) {
              await controller.host.command({
                kind: "set_overlay_scene",
                scene: snapshot.overlayScene,
              });
              sentSceneRef.current = snapshot.overlayScene;
            }
            if (
              snapshot.imageLayerPresentation
              && !sameImageLayerPresentation(
                sentImageLayerPresentationRef.current,
                snapshot.imageLayerPresentation,
              )
            ) {
              if (
                !sameImageLayerTransaction(
                  sentImageLayerPresentationRef.current,
                  snapshot.imageLayerPresentation,
                )
                && (
                  snapshot.imageLayerPresentation.sequence !== 0
                  || snapshot.imageLayerPresentation.moveDraft !== null
                )
              ) {
                const baseline: ImageLayerScenePresentation = {
                  ...snapshot.imageLayerPresentation,
                  sequence: 0,
                  moveDraft: null,
                };
                await controller.host.command({
                  kind: "present_image_layer_scene",
                  presentation: baseline,
                });
                sentImageLayerPresentationRef.current = baseline;
              }
              await controller.host.command({
                kind: "present_image_layer_scene",
                presentation: snapshot.imageLayerPresentation,
              });
              sentImageLayerPresentationRef.current = snapshot.imageLayerPresentation;
            }
            if (snapshot.presentEnabled && sentPresentEnabledRef.current !== true) {
              await controller.host.command({ kind: "set_presented", presented: true });
              sentPresentEnabledRef.current = true;
            }
            controller.appliedRevision = revision;
            controller.lastAppliedSnapshot = snapshot;
          } catch {
            controller.appliedRevision = revision;
            controller.finishedRenderRevision = revision;
            failCurrentSync(controller, revision);
          }
        }
      } finally {
        controller.syncing = false;
        if (controllerIsCurrent(controller)) {
          if (controller.appliedRevision < controller.requestedRevision) {
            drainSync(controller);
          } else {
            maybeStartRender(controller);
            maybeStartLive(controller);
          }
        }
      }
    })();
  }

  function requestSync(host: WgpuViewportHost | null = hostRef.current): void {
    const controller = controllerRef.current;
    if (!host || !controller || controller.host !== host || !controllerIsCurrent(controller)) return;
    controller.requestedRevision += 1;
    drainSync(controller);
  }

  function requestLive(host: WgpuViewportHost | null = hostRef.current): void {
    const controller = controllerRef.current;
    if (!host || !controller || controller.host !== host || !controllerIsCurrent(controller)) return;
    controller.liveRequestedRevision += 1;
    maybeStartLive(controller);
  }

  const noPlacementRef = useRef<HTMLElement | null>(null);
  const onPlaced = (report: { presented: boolean }) => {
    const host = hostRef.current;
    if (!report.presented || framePresentedRef.current) return;
    if (!host || !host.isOpen || !presentEnabledRef.current) return;
    requestSync(host);
  };
  useViewportPlacement(
    openHost,
    placementRef ?? noPlacementRef,
    presentEnabled,
    onPlaced,
    placementKey,
  );

  useEffect(() => {
    framePresentedRef.current = false;
    setState({
      underlay: null,
      presented: false,
      dims: null,
      frameView: IDENTITY_VIEW,
      backend: null,
      settled: false,
      targetSettled: false,
      renderedTargetKey: null,
      sceneSettled: false,
      renderedSceneKey: null,
      presentedImageLayerScene: null,
      selectedLayerFrame: null,
    });
    const initialSource = sourceRef.current;
    if (initialSource === undefined) return;
    let cancelled = false;
    let host: WgpuViewportHost | null = null;
    const settle = () => {
      if (!cancelled) setState((previous) => ({ ...previous, settled: true }));
    };

    void (async () => {
      // Preserve the browser-preview contract: an unresolved path does not
      // consume a host. The desired-state pass resolves it again immediately
      // before set_target so a later path revision cannot reuse this result.
      if (typeof initialSource === "string") {
        const resource = await registerResource(initialSource);
        if (!resource || cancelled) {
          settle();
          return;
        }
      }
      host = await WgpuViewportHost.open(kind);
      if (cancelled) {
        void host.close();
        return;
      }
      if (placementRef?.current && presentEnabledRef.current) {
        const placement = measurePlacement(placementRef.current, window.devicePixelRatio || 1);
        if (placement.width > 0 && placement.height > 0) {
          await host.place(placement).catch(() => null);
          if (cancelled) return;
        }
      }
      sentSizeRef.current = null;
      sentTargetKeyRef.current = null;
      sentImageSceneKeyRef.current = null;
      sentViewRef.current = IDENTITY_VIEW;
      sentOverlayRef.current = null;
      sentSceneRef.current = null;
      sentImageLayerPresentationRef.current = null;
      sentPresentEnabledRef.current = null;
      const controller: ViewportSyncController = {
        host,
        closed: false,
        requestedRevision: 0,
        appliedRevision: 0,
        finishedRenderRevision: 0,
        syncing: false,
        rendering: false,
        lastAppliedSnapshot: null,
        liveRequestedRevision: 0,
        liveCompletedRevision: 0,
        liveRunning: false,
      };
      hostRef.current = host;
      controllerRef.current = controller;
      setOpenHost(host);
    })().catch(() => settle());

    return () => {
      cancelled = true;
      const controller = controllerRef.current;
      if (controller && controller.host === host) {
        controller.closed = true;
        controllerRef.current = null;
      }
      if (hostRef.current === host) hostRef.current = null;
      setOpenHost(null);
      void host?.close();
    };
  }, [kind, hostKey]);

  useEffect(() => {
    requestSync(openHost);
    // The controller reads complete desired snapshots through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    openHost,
    size,
    targetKey,
    sceneKey,
    view.zoom,
    view.panX,
    view.panY,
    maskOverlay,
    overlayScene,
    imageLayerPresentation,
    presentEnabled,
  ]);

  useEffect(() => {
    requestLive(openHost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openHost, liveView?.zoom, liveView?.panX, liveView?.panY]);

  const exactTargetPresented = state.targetSettled && state.renderedTargetKey === targetKey;
  const exactScenePresented = state.renderedSceneKey === sceneKey;
  return {
    ...state,
    underlay: exactTargetPresented ? state.underlay : null,
    presented: exactTargetPresented ? state.presented : false,
    targetSettled: exactTargetPresented,
    sceneSettled: exactTargetPresented && exactScenePresented,
    presentedImageLayerScene: exactTargetPresented
      ? state.presentedImageLayerScene
      : null,
    selectedLayerFrame: exactTargetPresented ? state.selectedLayerFrame : null,
    host: openHost,
  };
}
