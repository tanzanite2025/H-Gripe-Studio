import { useT } from "../../i18n";
import type { CommandCapability, CommandId, StudioCommand } from "../studioCommands";
import type { TargetBounds } from "../studioTarget";

export interface ContextActionItem {
  command: StudioCommand;
  capability: CommandCapability;
}

interface ContextActionBarProps {
  bounds: TargetBounds | null;
  dims: { w: number; h: number };
  items: readonly ContextActionItem[];
  onCommand: (id: CommandId) => void;
}

function CommandIcon({ icon }: { icon: string }) {
  if (icon === "invert") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
      </svg>
    );
  }
  if (icon === "mask") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="8" r="3" fill="currentColor" />
      </svg>
    );
  }
  if (icon === "duplicate") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3" y="5" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6 3h5.8c.7 0 1.2.5 1.2 1.2V10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "delete") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 4.5h10M6.2 4.5V3.2h3.6v1.3M5 6v6.5c0 .7.5 1.2 1.2 1.2h3.6c.7 0 1.2-.5 1.2-1.2V6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === "transform") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 4l3 3M12 4 9 7M12 12 9 9M4 12l3-3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ContextActionBar({ bounds, dims, items, onCommand }: ContextActionBarProps) {
  const t = useT();
  if (!bounds || bounds.kind === "none" || bounds.kind === "document" || items.length === 0) return null;
  const [x0, , x1, y1] = bounds.rect;
  const left = ((x0 + x1) / 2 / Math.max(1, dims.w)) * 100;
  const top = (y1 / Math.max(1, dims.h)) * 100;
  return (
    <div
      className="mask-context-action-bar"
      style={{ left: `${left}%`, top: `${top}%` }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map(({ command, capability }) => {
        const title = capability.reason ? `${t(command.titleKey)} - ${capability.reason}` : t(command.titleKey);
        return (
          <button
            key={command.id}
            className={`mask-context-action${capability.danger ? " danger" : ""}`}
            title={title}
            aria-label={title}
            disabled={!capability.enabled}
            onClick={() => onCommand(command.id)}
          >
            <CommandIcon icon={command.icon} />
          </button>
        );
      })}
    </div>
  );
}
