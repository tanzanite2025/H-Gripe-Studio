// WgpuViewportHost: the product-facing boundary for heavy viewports (WGPU
// migration Phase 1). Editors own a host per open surface — open on demand,
// close on unmount — and never touch texture/transport code directly. Nothing
// in this module runs at import time, so no viewport can exist at app startup.

import {
  createViewport,
  destroyViewport,
  readViewportPixels,
  renderViewportFrame,
  resizeViewport,
  setViewportGrade,
  setViewportMaskOverlay,
  setViewportOverlayScene,
  setViewportPlacement,
  setViewportPresented,
  setViewportTarget,
  setViewportView,
  type ViewportBackend,
  type ViewportFrame,
  type ViewportKind,
  type ViewportMaskOverlay,
  type ViewportOverlayScene,
  type ViewportPlacement,
  type ViewportPlacementReport,
  type ViewportPixels,
  type ViewportTarget,
} from "../bridge/viewport";

export type ViewportCommand =
  | { kind: "set_target"; target: ViewportTarget }
  | { kind: "set_view"; zoom: number; panX: number; panY: number }
  | { kind: "resize"; width: number; height: number }
  /** Grade doc applied at render time (grading viewports only);
   * `temporalDenoise` (`0..=1`) blends graded video frames against the
   * previous graded frame during continuous playback. */
  | { kind: "set_grade"; doc: unknown | null; temporalDenoise?: number }
  /** Mask overlay composited over rendered frames (image_edit viewports):
   * the mask editor's selection tint, presented by the host at the view
   * window's detail. */
  | { kind: "set_mask_overlay"; overlay: ViewportMaskOverlay | null }
  /** Vector overlay stroked over rendered frames (image_edit and
   * video_preview viewports): selection outlines and safe-area guides drawn
   * host-side at the view window's detail. */
  | { kind: "set_overlay_scene"; scene: ViewportOverlayScene | null }
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
      case "set_view":
        await setViewportView(this.id(), cmd.zoom, cmd.panX, cmd.panY);
        return;
      case "set_mask_overlay":
        await setViewportMaskOverlay(this.id(), cmd.overlay);
        return;
      case "set_overlay_scene":
        await setViewportOverlayScene(this.id(), cmd.scene);
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

  /** Destroy the underlying viewport. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.viewportId === null) return;
    const id = this.viewportId;
    this.viewportId = null;
    for (const url of this.frameUrls.splice(0)) URL.revokeObjectURL(url);
    await destroyViewport(id);
  }
}
