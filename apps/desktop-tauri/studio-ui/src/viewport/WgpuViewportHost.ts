// WgpuViewportHost: the product-facing boundary for heavy viewports (WGPU
// migration Phase 1). Editors own a host per open surface — open on demand,
// close on unmount — and never touch texture/transport code directly. Nothing
// in this module runs at import time, so no viewport can exist at app startup.

import {
  createViewport,
  destroyViewport,
  exportViewportFrame,
  presentImageLayerScene,
  presentViewportView,
  readViewportPixels,
  renderViewportFrame,
  resizeViewport,
  setViewportClipProps,
  setViewportGrade,
  setViewportImageScene,
  setViewportMaskOverlay,
  setViewportOverlayScene,
  setViewportPlacement,
  setViewportPresented,
  setViewportTarget,
  setViewportView,
  type ViewportBackend,
  type ViewportFrameExportFormat,
  type ViewportFrameExportResult,
  type ViewportFrame,
  type ViewportKind,
  type ViewportImageScene,
  type ViewportMaskOverlay,
  type ViewportOverlayScene,
  type ViewportPlacement,
  type ViewportPlacementReport,
  type ViewportPixels,
  type ViewportTarget,
  type ImageLayerScenePresentation,
} from "../bridge/viewport";

export type ViewportCommand =
  | { kind: "set_target"; target: ViewportTarget }
  | { kind: "set_view"; zoom: number; panX: number; panY: number }
  | { kind: "resize"; width: number; height: number }
  /** Grade doc applied at render time (grading viewports only);
   * `temporalDenoise` (`0..=1`) blends graded video frames against the
   * previous graded frame during continuous playback. */
  | { kind: "set_grade"; doc: unknown | null; temporalDenoise?: number }
  /** Clip property document (serialized `ClipProperties` JSON) applied to
   * frames before the grade (video_preview viewports), evaluated at the
   * clip-local `timeSec`. */
  | { kind: "set_clip_props"; doc: string | null; timeSec?: number }
  /** Mask overlay composited over rendered frames (image_edit viewports):
   * the image editor's selection tint, presented by the host at the view
   * window's detail. */
  | { kind: "set_mask_overlay"; overlay: ViewportMaskOverlay | null }
  /** Vector overlay stroked over rendered frames (image_edit and
   * video_preview viewports): selection outlines and safe-area guides drawn
   * host-side at the view window's detail. */
  | { kind: "set_overlay_scene"; scene: ViewportOverlayScene | null }
  /** Commit a complete image document scene while keeping the resource target
   * and viewport host stable. */
  | { kind: "set_image_scene"; scene: ViewportImageScene }
  /** Atomically select the retained image layer scene transaction and its
   * current absolute move draft. This changes render geometry only. */
  | { kind: "present_image_layer_scene"; presentation: ImageLayerScenePresentation }
  /** Native surface presentation (surface swap Phase S1): the element rect
   * the host's surface window sits under, and whether it is shown at all. */
  | { kind: "set_placement"; placement: ViewportPlacement }
  | { kind: "set_presented"; presented: boolean };

export class WgpuViewportHost {
  private viewportId: string | null;
  readonly kind: ViewportKind;
  readonly backend: ViewportBackend;
  /** Object URLs of recent frames (desktop binary transport). The last two
   * stay alive — the newest is presented and the previous may still be the
   * committed `<img>` src until the caller re-renders — older ones revoke. */
  private frameUrls: string[] = [];

  private constructor(viewportId: string, kind: ViewportKind, backend: ViewportBackend) {
    this.viewportId = viewportId;
    this.kind = kind;
    this.backend = backend;
  }

  /** Open a viewport of `kind`. The caller owns it and must `close()` it. */
  static async open(kind: ViewportKind): Promise<WgpuViewportHost> {
    const desc = await createViewport(kind);
    return new WgpuViewportHost(desc.viewport_id, desc.kind, desc.backend);
  }

  get isOpen(): boolean {
    return this.viewportId !== null;
  }

  private id(): string {
    if (this.viewportId === null) throw new Error("viewport host is closed");
    return this.viewportId;
  }

  async command(cmd: ViewportCommand): Promise<void> {
    switch (cmd.kind) {
      case "set_target":
        await setViewportTarget(this.id(), cmd.target);
        return;
      case "resize":
        await resizeViewport(this.id(), cmd.width, cmd.height);
        return;
      case "set_grade":
        await setViewportGrade(this.id(), cmd.doc, cmd.temporalDenoise ?? 0);
        return;
      case "set_clip_props":
        await setViewportClipProps(this.id(), cmd.doc, cmd.timeSec ?? 0);
        return;
      case "set_view":
        await setViewportView(this.id(), cmd.zoom, cmd.panX, cmd.panY);
        return;
      case "set_mask_overlay":
        await setViewportMaskOverlay(this.id(), cmd.overlay);
        return;
      case "set_overlay_scene":
        await setViewportOverlayScene(this.id(), cmd.scene);
        return;
      case "set_image_scene":
        await setViewportImageScene(this.id(), cmd.scene);
        return;
      case "present_image_layer_scene":
        await presentImageLayerScene(this.id(), cmd.presentation);
        return;
      case "set_placement":
        await setViewportPlacement(this.id(), cmd.placement);
        return;
      case "set_presented":
        await setViewportPresented(this.id(), cmd.presented);
        return;
    }
  }

  /** Report the viewport element's rect for native surface placement and
   * learn whether the surface path took it (fallback contract). */
  async place(placement: ViewportPlacement): Promise<ViewportPlacementReport> {
    return setViewportPlacement(this.id(), placement);
  }

  /** The zoom/pan fast path (surface swap): set the view and re-present the
   * native surface's cached frame texture cropped to it — a pure GPU pass,
   * no render, no pixel transport. `false` means no presented texture took
   * it (browser preview, hidden surface): the caller waits for the settle
   * render instead. */
  async presentView(view: { zoom: number; panX: number; panY: number }): Promise<boolean> {
    return presentViewportView(this.id(), view.zoom, view.panX, view.panY);
  }

  async renderFrame(): Promise<ViewportFrame> {
    const frame = await renderViewportFrame(this.id());
    if (frame.data_url.startsWith("blob:")) {
      this.frameUrls.push(frame.data_url);
      while (this.frameUrls.length > 2) {
        URL.revokeObjectURL(this.frameUrls.shift() as string);
      }
    }
    return frame;
  }

  /** Explicit pixel readback (export preview, scopes, colour picking) —
   * never the per-frame path (surface swap Phase S4). */
  async readPixels(): Promise<ViewportPixels> {
    return readViewportPixels(this.id());
  }

  async exportFrame(
    path: string,
    format: ViewportFrameExportFormat,
  ): Promise<ViewportFrameExportResult> {
    return exportViewportFrame(this.id(), path, format);
  }

  /** Destroy the underlying viewport. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.viewportId === null) return;
    const id = this.viewportId;
    this.viewportId = null;
    for (const url of this.frameUrls.splice(0)) URL.revokeObjectURL(url);
    await destroyViewport(id);
  }
}
