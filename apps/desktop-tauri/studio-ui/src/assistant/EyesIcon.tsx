// Cursor-following "eyes" icon for the Prompt Assistant rail button: a round
// face with two pupils that look toward the mouse pointer, like the floating
// chat-assistant avatar on devrajchatribin.com. Pure SVG + one window
// mousemove listener (rAF-throttled); no dependencies.

import { useEffect, useRef, useState } from "react";

/**
 * Offset (px) of a pupil from its eye centre so it points at the cursor,
 * clamped to `max` so the pupil stays inside the eye white.
 */
export function pupilOffset(
  eyeX: number,
  eyeY: number,
  mouseX: number,
  mouseY: number,
  max: number,
): { dx: number; dy: number } {
  const dx = mouseX - eyeX;
  const dy = mouseY - eyeY;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { dx: 0, dy: 0 };
  const scale = Math.min(1, dist / 80) * max;
  return { dx: (dx / dist) * scale, dy: (dy / dist) * scale };
}

const PUPIL_MAX = 1.6;

export function EyesIcon({ size = 22 }: { size?: number }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });

  useEffect(() => {
    let frame = 0;
    const onMove = (e: MouseEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const el = svgRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        setOffset(pupilOffset(cx, cy, e.clientX, e.clientY, PUPIL_MAX));
      });
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const { dx, dy } = offset;
  return (
    <svg
      ref={svgRef}
      className="eyes-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="11" className="eyes-icon-face" />
      <ellipse cx="8.2" cy="11" rx="3" ry="3.6" className="eyes-icon-white" />
      <ellipse cx="15.8" cy="11" rx="3" ry="3.6" className="eyes-icon-white" />
      <circle cx={8.2 + dx} cy={11 + dy} r="1.5" className="eyes-icon-pupil" />
      <circle cx={15.8 + dx} cy={11 + dy} r="1.5" className="eyes-icon-pupil" />
    </svg>
  );
}
