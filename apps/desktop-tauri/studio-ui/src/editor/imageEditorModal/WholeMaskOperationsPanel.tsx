// Right rail whole-mask operations panel: invert, fill holes, morphology, and filters.
// These apply to the entire active mask rather than acting as hand tools, so
// they live here instead of the main Image Editor toolbar. Amount-taking ops
// enter live preview mode and commit through Apply; amount-less ops commit
// immediately.

import { useContext } from "react";
import { WHOLE_MASK_OPERATION_TOOL_IDS, imageEditorTool, type ImageEditorTool } from "../imageEditorTools";
import { localizeTool } from "../imageEditorToolsI18n";
import { LangContext } from "../../i18n";
import { isPreviewableOp } from "../maskMorphology";
import { ToolIcon } from "./toolIcons";

interface WholeMaskOperationsPanelProps {
  toolId: string;
  onToolClick: (tool: ImageEditorTool) => void;
}

export function WholeMaskOperationsPanel({ toolId, onToolClick }: WholeMaskOperationsPanelProps) {
  const lang = useContext(LangContext);
  return (
    <div className="mask-panel-body">
      <div className="mask-ops-grid">
        {WHOLE_MASK_OPERATION_TOOL_IDS.map((id) => {
          const mt = imageEditorTool(id);
          if (!mt) return null;
          const loc = localizeTool(mt, lang);
          const active = toolId === id && isPreviewableOp(id);
          return (
            <button
              key={id}
              className={`mask-op-button ${active ? "active" : ""}`}
              title={loc.hint}
              onClick={() => onToolClick(mt)}
            >
              <ToolIcon id={id} />
              <span className="label">{loc.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
