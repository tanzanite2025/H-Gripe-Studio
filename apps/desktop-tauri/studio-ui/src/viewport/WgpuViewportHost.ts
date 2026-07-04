// WgpuViewportHost: the product-facing boundary for heavy viewports (WGPU
// migration Phase 1). Editors own a host per open surface — open on demand,
// close on unmount — and never touch texture/transport code directly. Nothing
// in this module runs at import time, so no viewport can exist at app startup.

import {
  createViewport,
  destroyViewport,
  renderViewportFrame,
  resizeViewport,
  setViewportGrade,
  setViewportTarget,
  setViewportView,
  type ViewportBackend,
  type ViewportFrame,
  type ViewportKind,
  type ViewportTarget,
} from "../bridge/viewport";

export type ViewportCommand =
  | { kind: "set_target"; target: ViewportTarget }
  | { kind: "set_view"; zoom: number; panX: number; panY: number }
  | { kind: "resize"; width: number; height: number }
  /** Grade doc applied at render time (grading viewports only);
   * `temporalDenoise` (`0..=1`) blends graded video frames against the
   * previous graded frame during continuous playback. */
  | { kind: "set_grade"; doc: unknown | null; temporalDenoise?: number };

export class WgpuViewportHost {
  private viewportId: string | null;
  readonly kind: ViewportKind;
  readonly backend: ViewportBackend;

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
    }
  }

  async renderFrame(): Promise<ViewportFrame> {
    return renderViewportFrame(this.id());
  }

  /** Destroy the underlying viewport. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.viewportId === null) return;
    const id = this.viewportId;
    this.viewportId = null;
    await destroyViewport(id);
  }
}
