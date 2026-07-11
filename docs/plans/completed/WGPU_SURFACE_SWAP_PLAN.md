# WGPU Surface Swap Plan (Native Texture Presentation Endgame)

> Status: implemented. This is item 1 of the "remaining work" list in
> `WGPU_HEAVY_VIEWPORT_MIGRATION_PLAN.md`: replace the PNG hop with a real
> WGPU surface/texture swap on desktop. All viewport consumers now present
> natively — the image editor underlay (S5), the crop editor underlay, the
> program monitor, and the grade panel preview — with PNG/blob staying as
> the browser-preview and no-adapter fallback. The host command protocol is
> the stable boundary, so this plan changes the presentation transport only —
> no product-layer rework.

> 2026-07 correction: this is implemented as a transport capability, not a
> license to make editor chrome transparent. A native surface is product-safe
> only when the transparent hole is scoped to the owning viewport slot. If an
> editor would need transparent app roots, shared modal backdrops, or shared
> modal shells to reveal the surface, that editor must keep native presentation
> disabled until it owns a scoped matte/hole layer.

## Current State (What We Replace)

Today every rendered frame takes this path:

```text
viewport_render_frame_bin (Rust)
  -> resolve target -> decode proxy -> grade kernel (wgpu compute or CPU)
  -> crop view window -> encode PNG
  -> IPC binary payload (length-prefixed meta JSON + PNG bytes)
  -> frontend blob object URL -> <img src>
```

The PNG encode + IPC copy + browser decode happens on **every** frame — slider
drags, zoom/pan, playback. That is the latency and throughput ceiling this
plan removes on desktop.

Target path:

```text
host renders straight into a native wgpu surface
  positioned at the viewport element's rect, under the webview
  -> present via swapchain (no encode, no IPC pixels, no browser decode)
readback happens only when needed (export, scopes, colour picking)
```

The PNG/blob transport **stays** as the browser-preview path and as the
runtime fallback whenever a surface or adapter cannot be created. Callers keep
talking to `WgpuViewportHost` / the `viewport_*` commands; nothing above the
host boundary changes semantically.

## Core Design Decisions

### D1. Presentation window: native child window under the webview

On desktop the host creates one **native child window** per presented
viewport, parented to the main app window, sitting **below** the webview in
z-order. The webview is made transparent where the viewport element lives (the
element renders no background), so the surface shows through the "hole" while
all DOM UI (toolbars, panels, existing 2D-canvas overlays like brush/marquee)
keeps compositing **above** the surface. This is the standard wry/Tauri-2
layered approach and is exactly what item 2 (interactive overlays) needs
later: overlays stay DOM until they move onto the live surface.

Consequences:

- The main window webview must be created transparent
  (`transparent: true` + transparent HTML/body background); opaque app
  chrome is painted by the app's own root container instead of the window.
- The transparent WebView requirement does not permit transparent app chrome.
  The app root, shared modal backdrop, and shared modal shell must stay opaque.
  A viewport may reveal a native surface only through its own local slot/hole.
  Do not use `.app:has(...presented)`,
  `.media-viewer-backdrop:has(...presented)`, or
  `.media-viewer:has(...presented)` to reveal a surface.
- Input: the surface window never takes input; events fall through to the
  webview above it, so zoom/pan/brush interactions keep their current DOM
  handlers unchanged.
- Windows first (WebView2 + Win32 child HWND). The seam is
  `raw-window-handle`, so macOS/Linux come later without protocol changes.

### D2. One shared wgpu device, per-viewport surfaces

A process-wide `OnceLock` wgpu `Instance/Adapter/Device/Queue` (created
lazily on the first surface request — never at app startup, per the
performance rules). Each presented viewport owns:

- a `wgpu::Surface` created from the child window's raw handle,
- a swapchain configured to the placement size (physical pixels),
- a cached source texture (the decoded proxy uploaded once per proxy key),
- the existing `hgripe-grade` GPU passes for grade application,
- a small blit/composite pipeline: sample view window from the source
  texture, apply mask-overlay tint, letterbox, present.

Slider drags then re-run only the grade pass + blit on the already-uploaded
texture: zero decode, zero encode, zero IPC pixels.

### D3. Placement protocol (new host commands)

The frontend already owns the element rect; it now reports it:

```ts
// WgpuViewportHost additions
| { kind: "set_placement"; x: number; y: number; width: number; height: number; dpr: number }
| { kind: "set_presented"; presented: boolean }   // hide without destroying
```

```rust
viewport_set_placement(viewport_id, x, y, w, h, dpr) // logical CSS px + scale
viewport_set_presented(viewport_id, presented: bool)
```

Frontend side: a `useViewportPlacement(hostRef, elementRef)` hook tracks the
element via `ResizeObserver` + scroll/layout changes (rAF-throttled) and sends
`set_placement`; on unmount it sends `set_presented: false`. The host converts
logical to physical pixels with `dpr`, moves/resizes the child window, and
reconfigures the swapchain on size change.

### D4. Render triggering

`viewport_render_frame` keeps its role as "produce the current frame", but on
the surface path it draws into the swapchain and returns a `ViewportFrame`
**without** pixel payload:

```rust
pub(crate) struct ViewportFrame {
    /// "surface" when presented natively; a blob/data URL on the fallback path.
    pub data_url: String,          // "" on the surface path
    pub presented: bool,           // true when the frame went to the surface
    pub width: u32,
    pub height: u32,
    pub backend: ViewportBackend,  // actual: "wgpu"
}
```

`WgpuViewportHost.renderFrame()` returns the frame as today; presenting
components (`useViewportUnderlay`, `useVideoPreview`, program monitor, mask
editor) treat `presented: true` as "clear the `<img>`, keep the transparent
hole" only when the owning surface already has a scoped hole. If the only way
to show the surface is to make the app root, shared modal backdrop, or shared
modal shell transparent, the presenter must not request native presentation.
The mocked browser transport and the CPU fallback keep returning blob/data URLs,
so every caller works on both paths with one small branch.

### D5. Readback only when needed

A new host command for the explicit readback cases (export preview, scopes,
colour picking):

```rust
viewport_read_pixels(viewport_id, /* optional rect */) -> binary RGBA payload
```

Implemented as a copy from the last rendered texture into a mapped buffer.
Nothing else reads the surface back. Export itself already goes through the
render plan + kernel (Phase 5), not through the viewport.

### D6. Fallback contract (unchanged philosophy)

Every failure point downgrades to the existing PNG/blob path and reports it:

```text
requested: auto | gpu | cpu
actual:    wgpu (surface) | wgpu (readback) | cpu
fallbackReason: "no adapter" | "surface creation failed" | "browser preview" | ...
```

The `ViewportBackendBadge` and `DeviceReport` wiring already render this
vocabulary; the surface path just finally reports `actual: "wgpu"`.

## Implementation Phases

### Phase S0: Device singleton + feature flag

- Cargo feature `viewport-surface` (default on for Windows desktop builds).
- `studio/wgpu_device.rs`: lazy shared Instance/Adapter/Device/Queue with a
  `DeviceReport`; unit-testable "no adapter → reported fallback".
- No behavior change yet; `viewport_render_frame_bin` untouched.

Exit: device initialises lazily on first use, never at startup; fallback
report visible in logs.

### Phase S1: Child window + placement plumbing

- Create/destroy a child window per viewport on demand (Tauri main-thread
  dispatch), parented under the webview, no input, hidden until first
  `set_placement`.
- New commands `viewport_set_placement` / `viewport_set_presented`; frontend
  `set_placement`/`set_presented` host commands + `useViewportPlacement` hook.
- Make the main window/webview transparent; app root paints the chrome
  background. Verify DOM still composites above a test-cleared surface.
  This means the WebView can support local holes; it does not mean the app root
  or shared modal shells may become transparent when a viewport presents.

Exit: a viewport can show a solid clear colour exactly under its element,
tracks resize/scroll/DPI, and disappears on close — behind the feature flag.

### Phase S2: Image path on the surface

- Upload the decoded source proxy as a texture (cached by `ProxyKey`).
- Blit pipeline: view window crop + letterbox + background; wire
  `hgripe-grade` GPU passes so `set_grade` re-renders without re-upload.
- `viewport_render_frame` presents to the surface for `image_edit` /
  `grade_preview` viewports; `ViewportFrame.presented` lands in the frontend
  presenters (clear `<img>` when presented).
- Mask overlay: composite the coverage buffer in the blit shader
  (`set_mask_overlay` uploads it as an R8 texture).

Exit: image edit underlay, grade preview, and the image editor underlay render
on the live surface; slider drag does no decode/encode; CPU/browser fallback
still renders identically via PNG.

### Phase S3: Video path on the surface

- `video_frame` / `video_clip` targets upload decoded frames to the texture
  path; playback presents on the surface with the existing latest-wins seek
  coalescing and temporal denoise blend moved into the grade/blit pass.

Exit: program monitor playback/scrub presents natively; no PNG per frame.

### Phase S4: Readback, parity tests, and reporting polish

- `viewport_read_pixels` + golden parity test: surface-path readback matches
  the CPU reference path within the Phase-5 tolerance for a grade matrix.
- `DeviceReport` shows `used: wgpu` on presented surfaces; badge tooltips
  carry the adapter/backend name.
- Placement math unit tests (logical→physical, clamping, DPI change).

Exit: parity green in CI (CPU fallback asserted on CI runners without GPU);
badges truthful on both paths.

### Phase S5: Image editor on the live surface (follow-up, done)

- The image editor's underlay presents on the native surface: the stage keeps
  a placement anchor at the underlay window's rect, `useViewportUnderlay`
  tracks it (`useViewportPlacement` gains an `enabled` flag), and the
  brush/path/marquee canvas — DOM, above the webview hole — keeps compositing
  over the surface unchanged. The selection tint stays host-side
  (`set_mask_overlay`), so it is composited into the presented frame. After the
  2026-07 modal-boundary correction, this is valid only when the webview hole is
  scoped inside the editor stage and does not require transparent app roots or
  shared modal shells.
- Selection semantics are not owned by the surface path. DOM canvas fallback
  and WGPU overlays both consume the same state model from
  [`../active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md`](../active/IMAGE_EDITOR_SELECTION_STATE_PROTOCOL_PLAN.md):
  solid drafts remain drafts; only committed active selections render as
  marching ants and become command targets.
- States the surface cannot represent fall back to the PNG transport without
  re-opening the host: a rotated view (the CSS transform rotates the DOM, not
  the surface window) and the transparency preview hide the surface
  (`set_presented: false`) and re-render.
- The eyedropper reads a presented frame via `viewport_read_pixels` (S4)
  instead of decoding a data URL.

Exit: brush/path/marquee/shape overlays draw over the natively presented
underlay; rotate/transparency-preview fall back to PNG; browser preview
unchanged.

## Testing Strategy

- **CI (no GPU):** everything must pass with the fallback path — feature
  compiled in, adapter absent → reported CPU/PNG fallback. Placement math,
  protocol serialization, and fallback reporting are plain unit tests.
- **Golden parity:** `viewport_read_pixels` vs CPU reference per grade doc
  (reuses the Phase 5 tolerance machinery) — runs when an adapter exists,
  asserts the fallback report otherwise.
- **Manual/recorded desktop checks:** hole alignment under zoom/scroll/DPI
  change, z-order (DOM overlays above surface), open/close leak check via the
  existing lifecycle logs.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Webview transparency regressions (app chrome flashes) | root container paints opaque background; transparency only where a viewport is presented |
| DPI / multi-monitor placement drift | placement carries `dpr`; child window repositions on `set_placement` only — frontend is the single source of the rect; unit-test the math |
| Z-order quirks per platform | Windows-only first; `raw-window-handle` seam keeps macOS/Linux additive |
| GPU device loss | recreate device/surfaces lazily on next render; one-shot fallback frame via PNG path meanwhile |
| CI has no GPU | fallback contract is first-class and tested; parity tests self-skip to fallback assertions |
| Occlusion (modals/panels over the hole) | presenters send `set_presented: false` when hidden; modal shells already unmount editors on close |

## Out Of Scope (Follow-Ups)

- Safe area / crop box / scopes overlay surfaces — item 3.
- Node canvas migration, FFmpeg hardware decode, cross-kernel GPU scheduler —
  unchanged per the migration plan's guardrails.
