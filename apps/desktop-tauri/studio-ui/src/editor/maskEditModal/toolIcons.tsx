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
  hand: (
    <g {...P}>
      <path d="M5 8V4.5a1 1 0 0 1 2 0V7m0-3.5a1 1 0 0 1 2 0V7m0-2.5a1 1 0 0 1 2 0V8m0-.5a1 1 0 0 1 2 0v3c0 2-1.5 3.5-4 3.5S5.5 13 4.5 11L3.2 8.6a1 1 0 0 1 1.8-.9z" />
    </g>
  ),
  rotate_view: (
    <g {...P}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v2.2h-2.2" />
    </g>
  ),
  zoom: (
    <g {...P}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3l3.5 3.5" />
      <path d="M5 7h4M7 5v4" />
    </g>
  ),
};

/** The toolbar glyph for a tool id (falls back to a plain dot). */
export function ToolIcon({ id }: { id: string }) {
  return (
    <svg className="mask-tool-icon" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      {ICONS[id] ?? <circle cx="8" cy="8" r="2" fill="currentColor" />}
    </svg>
  );
}
