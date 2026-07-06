import { useT } from "../i18n";

interface ToolRailProps {
  assistantOpen: boolean;
  onToggleAssistant: () => void;
}

// Right tool rail shell (PROMPT_ASSISTANT_SYSTEM_PLAN): always visible on the
// right edge, above the bottom production drawer, so software-level panels
// stay reachable while the drawer is open. Prompt Assistant is the first
// entry; Assets / History / Settings join later.
export function ToolRail({ assistantOpen, onToggleAssistant }: ToolRailProps) {
  const t = useT();
  return (
    <div className="tool-rail" role="toolbar" aria-label={t("assistant.railLabel")}>
      <button
        className={assistantOpen ? "tool-rail-btn active" : "tool-rail-btn"}
        onClick={onToggleAssistant}
        title={t("assistant.title")}
        aria-label={t("assistant.title")}
        aria-pressed={assistantOpen}
      >
        P
      </button>
    </div>
  );
}
