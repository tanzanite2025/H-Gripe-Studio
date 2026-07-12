import { useT } from "../../i18n";
import type { CommandCapability, CommandId, StudioCommand } from "../studioCommands";

export interface ContextActionItem {
  command: StudioCommand;
  capability: CommandCapability;
}

interface ContextActionBarProps {
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
  if (icon === "duplicate") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3" y="5" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6 3h5.8c.7 0 1.2.5 1.2 1.2V10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "subject") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.2 12.7c.4-2 1.8-3.2 3.8-3.2s3.4 1.2 3.8 3.2" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        <circle cx="8" cy="5.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.35" />
        <path d="M2.3 3.8V2.3h1.5M12.2 2.3h1.5v1.5M13.7 12.2v1.5h-1.5M3.8 13.7H2.3v-1.5" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
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
  if (icon === "visibility-off") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2.2 8s2-3.4 5.8-3.4S13.8 8 13.8 8s-2 3.4-5.8 3.4S2.2 8 2.2 8z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        <circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <path d="M3.2 12.8 12.8 3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ContextActionBar({ items, onCommand }: ContextActionBarProps) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <div
      className="mask-context-action-bar"
      role="toolbar"
      aria-label="Layer context actions"
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
