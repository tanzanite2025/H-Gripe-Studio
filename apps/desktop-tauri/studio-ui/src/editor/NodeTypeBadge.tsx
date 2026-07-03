import type { JSX } from "react";
import type { NodeVisualFamily } from "../graph/nodeSpecs";

// Corner-anchored circular type badge: the circle's center point is exactly
// the card's top-right corner (1/4 inside the card, 3/4 outside). Identity
// only — an icon, no text, no status. Geometry lives in styles.css under
// `.node-type-badge` (see NODE_CARD_CORNER_BADGE_PLAN.md).

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

// Minimal lucide-style 24×24 stroke icons, one per visual family.
const FAMILY_ICON: Record<NodeVisualFamily, JSX.Element> = {
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m10 9 5 3-5 3z" />
    </>
  ),
  audio: (
    <>
      <path d="M3 10v4" />
      <path d="M7 7v10" />
      <path d="M11 4v16" />
      <path d="M15 7v10" />
      <path d="M19 10v4" />
    </>
  ),
  psd: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  mask: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </>
  ),
  crop: (
    <>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </>
  ),
  grade: (
    <>
      <path d="M3 7h4M11 7h10" />
      <circle cx="9" cy="7" r="2" />
      <path d="M3 17h10M17 17h4" />
      <circle cx="15" cy="17" r="2" />
    </>
  ),
  api: (
    <>
      <path d="M17.5 19a4.5 4.5 0 1 0-1-8.9A6 6 0 1 0 6 15.7" />
      <path d="M6 19h11.5" />
    </>
  ),
  compute: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="10" y="10" width="4" height="4" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v12" />
      <path d="m7 11 5 4 5-4" />
      <path d="M4 19h16" />
    </>
  ),
  utility: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
};

export function NodeTypeBadge({ family }: { family: NodeVisualFamily }) {
  return (
    <span className={`node-type-badge family-${family}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" {...STROKE}>
        {FAMILY_ICON[family]}
      </svg>
    </span>
  );
}
