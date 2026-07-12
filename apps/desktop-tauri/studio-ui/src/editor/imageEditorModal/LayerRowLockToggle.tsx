import type { MouseEvent } from "react";

import "./LayerRowLockToggle.css";

interface LayerRowLockToggleProps {
  locked: boolean;
  title: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}

export function LayerRowLockToggle({ locked, title, onClick }: LayerRowLockToggleProps) {
  return (
    <button
      className={`mask-layer-row-lock${locked ? " locked" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={locked}
      onClick={onClick}
    >
      <span className="mask-layer-row-lock-track" aria-hidden="true">
        <span className="mask-layer-row-lock-thumb" />
        <svg className="mask-layer-row-lock-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4.2 7V5.6a3.8 3.8 0 0 1 7.6 0V7M4 7h8c.6 0 1 .4 1 1v4.4c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V8c0-.6.4-1 1-1Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
}
