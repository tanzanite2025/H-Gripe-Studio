// PS-style toolbar glyphs: one 16×16 stroke icon per mask-tool id, drawn
// inline so the toolbar needs no icon-font / asset pipeline. Icons inherit
// `currentColor`, so active/hover states colour them via CSS.

import type { ReactElement } from "react";

const P = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const ICONS: Record<string, ReactElement> = {
  move: (
    <g {...P}>
      <path d="M8 2v12M2 8h12" />
      <path d="M8 2l-2 2M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2" />
    </g>
  ),
  rect: (
    <g {...P} strokeDasharray="2.2 1.6">
      <rect x="2.5" y="3.5" width="11" height="9" rx="0.5" />
    </g>
  ),
  ellipse: (
    <g {...P} strokeDasharray="2.2 1.6">
      <ellipse cx="8" cy="8" rx="5.5" ry="4.5" />
    </g>
  ),
  lasso: (
    <g {...P}>
      <path d="M13.5 7c0 2.5-2.5 4.5-5.5 4.5S2.5 9.5 2.5 7 5 2.5 8 2.5 13.5 4.5 13.5 7z" strokeDasharray="2.2 1.6" />
      <path d="M6 11.2c-1 .8-1.5 1.8-.8 2.6" />
    </g>
  ),
  wand: (
    <g {...P}>
      <path d="M9.5 6.5L3 13" />
      <path d="M11.5 2v2M11.5 8v2M8.5 5h2M12.5 5h2M9.6 3.1l1.2 1.2M13.7 7.2l-1.2-1.2M9.6 6.9l1.2-1.2M13.7 2.8l-1.2 1.2" />
    </g>
  ),
  point: (
    <g {...P}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" />
    </g>
  ),
  crop: (
    <g {...P}>
      <path d="M4.5 1.5v10h10" />
      <path d="M1.5 4.5h10v10" />
    </g>
  ),
  eyedropper: (
    <g {...P}>
      <path d="M9.5 6.5L3.5 12.5l-1 2 2-1 6-6" />
      <path d="M9 4l3 3 1.5-1.5a2.1 2.1 0 0 0-3-3L9 4z" />
    </g>
  ),
  heal: (
    <g {...P}>
      <path d="M6.5 2.5h3v4h4v3h-4v4h-3v-4h-4v-3h4z" />
    </g>
  ),
  brush: (
    <g {...P}>
      <path d="M13.5 2.5l-6 6" />
      <path d="M7.5 8.5c-2 0-3.5 1.5-3.5 3.5-1 1-1.5 1.2-2.5 1.5 2.5 1 5.5.5 6.5-1 .8-1.2.5-3-.5-4z" />
    </g>
  ),
  matting: (
    <g {...P}>
      <path d="M2.5 11c2-4 4-7 5.5-8.5" />
      <path d="M6 12c2-3.5 4.5-6.5 7-8.5" />
      <path d="M9.5 13c1.5-2.5 3-4.5 4-5.5" />
    </g>
  ),
  clone: (
    <g {...P}>
      <path d="M5.5 6.5h5l1.5 7h-8z" />
      <path d="M5.5 6.5a2.5 2.5 0 1 1 5 0" />
    </g>
  ),
  history_brush: (
    <g {...P}>
      <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9" />
      <path d="M2.5 8v-3M2.5 8h3" />
      <path d="M8 5.5V8l2 1.5" />
    </g>
  ),
  eraser: (
    <g {...P}>
      <path d="M5.5 13.5l-3-3 7-7 4.5 4.5-5.5 5.5z" />
      <path d="M6.5 5.5l4.5 4.5" />
    </g>
  ),
  gradient: (
    <g {...P}>
      <rect x="2.5" y="4.5" width="11" height="7" rx="0.5" />
      <path d="M5 4.5v7M7.5 4.5v7M10 4.5v7" opacity="0.55" />
    </g>
  ),
  dodge_burn: (
    <g {...P}>
      <circle cx="8" cy="8" r="4" />
      <path d="M8 4a4 4 0 0 1 0 8z" fill="currentColor" stroke="none" opacity="0.6" />
    </g>
  ),
  pen: (
    <g {...P}>
      <path d="M8 2.5l3.5 6-3.5 5-3.5-5z" />
      <circle cx="8" cy="13" r="1" />
    </g>
  ),
  shape: (
    <g {...P}>
      <path d="M8 2.5l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 11l-3.3 1.7.7-3.7-2.7-2.6 3.7-.5z" />
    </g>
  ),
  invert: (
    <g {...P}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" opacity="0.6" />
    </g>
  ),
  fill_holes: (
    <g {...P}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.8" strokeDasharray="1.6 1.4" />
    </g>
  ),
  smooth: (
    <g {...P}>
      <path d="M2.5 10c1.5-4 3.5-6 5.5-6s4 2 5.5 6" />
      <path d="M2.5 12.5h11" opacity="0.55" />
    </g>
  ),
  grow: (
    <g {...P}>
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="5.5" strokeDasharray="2 1.6" opacity="0.7" />
    </g>
  ),
  shrink: (
    <g {...P}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2.5" strokeDasharray="2 1.6" opacity="0.7" />
    </g>
  ),
  feather: (
    <g {...P}>
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="5" opacity="0.45" />
      <circle cx="8" cy="8" r="6.5" opacity="0.2" />
    </g>
  ),
  blur: (
    <g {...P}>
      <path d="M8 2.5c2.5 3 4 5 4 7a4 4 0 1 1-8 0c0-2 1.5-4 4-7z" />
    </g>
  ),
  sharpen: (
    <g {...P}>
      <path d="M8 2.5l5 11H3z" />
    </g>
  ),
  polygon_lasso: (
    <g {...P}>
      <path d="M3 10.5L5.5 4l5-1.5 3 4-3.5 5-5 .5z" strokeDasharray="2.2 1.6" />
      <path d="M4.5 12.5c-1 .8-1.4 1.6-.8 2.4" />
    </g>
  ),
  magnetic_lasso: (
    <g {...P}>
      <path d="M13.5 7c0 2.5-2.5 4.5-5.5 4.5S2.5 9.5 2.5 7 5 2.5 8 2.5 13.5 4.5 13.5 7z" strokeDasharray="2.2 1.6" />
      <path d="M11 10.5v2.5M13 10.5v2.5M11 13h2" />
    </g>
  ),
  object_select: (
    <g {...P}>
      <rect x="2.5" y="3" width="11" height="10" rx="0.5" strokeDasharray="2.2 1.6" />
      <circle cx="8" cy="7" r="1.5" />
      <path d="M5.5 11c.5-1.5 1.5-2.2 2.5-2.2s2 .7 2.5 2.2" />
    </g>
  ),
  quick_select: (
    <g {...P}>
      <circle cx="6.5" cy="9.5" r="3.5" strokeDasharray="2 1.5" />
      <path d="M9 7l4-4" />
      <path d="M11.2 2.6l1.2 1.2 1-2.2z" />
    </g>
  ),
  color_sampler: (
    <g {...P}>
      <path d="M9.5 6.5L3.5 12.5l-1 2 2-1 6-6" />
      <path d="M9 4l3 3 1.5-1.5a2.1 2.1 0 0 0-3-3L9 4z" />
      <path d="M12 11.5h2.5M13.25 10.25v2.5" />
    </g>
  ),
  remove: (
    <g {...P}>
      <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 1.6" />
      <path d="M5.5 8h5" />
    </g>
  ),
  healing_brush: (
    <g {...P}>
      <path d="M7 3.5h2v3.5h3.5v2H9v3.5H7V9H3.5V7H7z" />
      <path d="M12.5 12l1.5 1.5" />
    </g>
  ),
  patch: (
    <g {...P}>
      <path d="M3 6.5c0-2 1.5-3.5 3.5-3.5S10 4.5 10 6.5 8.5 10 6.5 10 3 8.5 3 6.5z" strokeDasharray="2 1.5" />
      <path d="M10 9.5c2 .5 3 1.8 3 3.5" />
      <path d="M11.6 12.2l1.4.8.8-1.4" />
    </g>
  ),
  content_aware_move: (
    <g {...P}>
      <path d="M4.5 4.5h4v4h-4z" strokeDasharray="1.8 1.4" />
      <path d="M9.5 8.5h3v3h-3z" />
      <path d="M8.5 6.5c2 0 3.5 1 3.5 2" opacity="0.6" />
    </g>
  ),
  red_eye: (
    <g {...P}>
      <path d="M2 8c1.8-2.8 3.8-4.2 6-4.2S12.2 5.2 14 8c-1.8 2.8-3.8 4.2-6 4.2S3.8 10.8 2 8z" />
      <circle cx="8" cy="8" r="2" />
    </g>
  ),
  pencil: (
    <g {...P}>
      <path d="M10.5 2.5l3 3-8 8-3.5.5.5-3.5z" />
      <path d="M9.5 3.5l3 3" />
    </g>
  ),
  color_replacement: (
    <g {...P}>
      <path d="M12.5 3.5l-5 5" />
      <path d="M7.5 8.5c-1.6 0-3 1.4-3 3-.8.8-1.3 1-2 1.2 2 .8 4.4.4 5.2-.8.7-1 .4-2.4-.2-3.4z" />
      <circle cx="12" cy="11.5" r="1.6" />
    </g>
  ),
  mixer_brush: (
    <g {...P}>
      <path d="M13.5 2.5l-6 6" />
      <path d="M7.5 8.5c-2 0-3.5 1.5-3.5 3.5-1 1-1.5 1.2-2.5 1.5 2.5 1 5.5.5 6.5-1 .8-1.2.5-3-.5-4z" />
      <path d="M11 10.5c1 1.2 1.5 2.1 1.5 2.8a1.5 1.5 0 1 1-3 0c0-.7.5-1.6 1.5-2.8z" />
    </g>
  ),
  pattern_stamp: (
    <g {...P}>
      <path d="M5.5 6.5h5l1.5 7h-8z" />
      <path d="M5.5 6.5a2.5 2.5 0 1 1 5 0" />
      <path d="M6 10.5h4M6.5 12h3" opacity="0.55" />
    </g>
  ),
  art_history_brush: (
    <g {...P}>
      <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9" />
      <path d="M2.5 8v-3M2.5 8h3" />
      <path d="M6.5 8c1-1.5 2.5-2 4-1.5" opacity="0.7" />
      <path d="M6.5 10c1.5-.8 3-.8 4.5 0" opacity="0.45" />
    </g>
  ),
  background_eraser: (
    <g {...P}>
      <path d="M5.5 13.5l-3-3 7-7 4.5 4.5-5.5 5.5z" />
      <circle cx="8.5" cy="7.5" r="1.2" strokeDasharray="1.4 1.2" />
    </g>
  ),
  magic_eraser: (
    <g {...P}>
      <path d="M5.5 13.5l-3-3 6-6 4.5 4.5-4.5 4.5z" />
      <path d="M11.5 2v1.6M11.5 6.4V8M9 4.5h1.6M12.4 4.5H14" />
    </g>
  ),
  paint_bucket: (
    <g {...P}>
      <path d="M8 3l5 5-4.5 4.5a1.5 1.5 0 0 1-2 0L3 9z" />
      <path d="M8 3L6.5 1.5" />
      <path d="M13.5 10.5c.7 1 1 1.7 1 2.2a1 1 0 1 1-2 0c0-.5.3-1.2 1-2.2z" />
    </g>
  ),
  sponge: (
    <g {...P}>
      <rect x="3" y="5" width="10" height="6.5" rx="2.5" />
      <path d="M6 7.2v2M8 6.8v2.6M10 7.2v2" opacity="0.55" />
    </g>
  ),
  freeform_pen: (
    <g {...P}>
      <path d="M8 2.5l3.5 6-3.5 5-3.5-5z" />
      <path d="M4 13.5c1.5-1 3-1 4.5 0s3 .8 4-.5" opacity="0.7" />
    </g>
  ),
  curvature_pen: (
    <g {...P}>
      <path d="M2.5 11.5c2-5 6-7.5 11-7" />
      <circle cx="2.5" cy="11.5" r="1.2" />
      <circle cx="13.5" cy="4.5" r="1.2" />
      <circle cx="8" cy="6.8" r="1" strokeDasharray="1.2 1" />
    </g>
  ),
  type_horizontal: (
    <g {...P}>
      <path d="M3.5 4.5v-1h9v1" />
      <path d="M8 3.5v9M6.5 12.5h3" />
    </g>
  ),
  type_vertical: (
    <g {...P}>
      <path d="M3.5 4.5v-1h9v1" />
      <path d="M8 3.5v9M6.5 12.5h3" />
      <path d="M13.5 6v4l1-1M13.5 10l-1-1" opacity="0.7" />
    </g>
  ),
  path_select: (
    <g {...P}>
      <path d="M6 2.5l6 6-3.6.4 2.1 3.6-1.8 1-2-3.7L4.5 12z" fill="currentColor" stroke="none" opacity="0.85" />
    </g>
  ),
  rotate_view: (
    <g {...P}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v2.2h-2.2" />
    </g>
  ),
};

/** Whether a dedicated glyph exists for the id (registry test coverage). */
export function hasToolIcon(id: string): boolean {
  return id in ICONS;
}

/** The toolbar glyph for a tool id (falls back to a plain dot). */
export function ToolIcon({ id }: { id: string }) {
  return (
    <svg className="mask-tool-icon" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      {ICONS[id] ?? <circle cx="8" cy="8" r="2" fill="currentColor" />}
    </svg>
  );
}
