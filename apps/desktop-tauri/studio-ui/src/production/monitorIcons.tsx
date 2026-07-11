// Inline SVG icons for the program monitor's transport / marker controls.

import type { ReactNode } from "react";

function MonitorIcon({ children }: { children: ReactNode }) {
  return (
    <svg className="production-monitor-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function MarkerIcon() {
  return (
    <MonitorIcon>
      <path d="M7 4h10v10l-5 4-5-4z" />
    </MonitorIcon>
  );
}

export function MarkInIcon() {
  return (
    <MonitorIcon>
      <path d="M8 5v14" />
      <path d="M16 7 11 12l5 5" />
    </MonitorIcon>
  );
}

export function MarkOutIcon() {
  return (
    <MonitorIcon>
      <path d="M16 5v14" />
      <path d="m8 7 5 5-5 5" />
    </MonitorIcon>
  );
}

export function StepBackIcon() {
  return (
    <MonitorIcon>
      <path d="M8 6v12" />
      <path d="m17 7-7 5 7 5z" />
    </MonitorIcon>
  );
}

export function StepForwardIcon() {
  return (
    <MonitorIcon>
      <path d="M16 6v12" />
      <path d="m7 7 7 5-7 5z" />
    </MonitorIcon>
  );
}

export function RewindIcon() {
  return (
    <MonitorIcon>
      <path d="m11 7-7 5 7 5z" />
      <path d="m20 7-7 5 7 5z" />
    </MonitorIcon>
  );
}

export function FastForwardIcon() {
  return (
    <MonitorIcon>
      <path d="m4 7 7 5-7 5z" />
      <path d="m13 7 7 5-7 5z" />
    </MonitorIcon>
  );
}

export function LoopPlaybackIcon() {
  return (
    <MonitorIcon>
      <path d="M7 7h9.5a3.5 3.5 0 0 1 0 7H8" />
      <path d="m13 4 3 3-3 3" />
      <path d="M17 17H7.5a3.5 3.5 0 0 1 0-7H16" />
      <path d="m11 20-3-3 3-3" />
    </MonitorIcon>
  );
}

export function PlayIcon() {
  return (
    <MonitorIcon>
      <path d="m8 5 11 7-11 7z" />
    </MonitorIcon>
  );
}

export function PauseIcon() {
  return (
    <MonitorIcon>
      <path d="M8 5v14" />
      <path d="M16 5v14" />
    </MonitorIcon>
  );
}

export function SafeAreaIcon() {
  return (
    <MonitorIcon>
      <rect x="5" y="6" width="14" height="12" rx="1.5" />
      <rect x="8" y="8.5" width="8" height="7" rx="1" />
    </MonitorIcon>
  );
}

export function ExportFrameIcon() {
  return (
    <MonitorIcon>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M8 19h8" />
      <path d="M12 16v3" />
      <path d="M12 8v5" />
      <path d="m9.5 10.5 2.5 2.5 2.5-2.5" />
    </MonitorIcon>
  );
}
