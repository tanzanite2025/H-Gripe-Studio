// Right rail — "Mask ops" panel: whole-mask operations (invert, fill holes,
// morphology, filters). These apply to the entire mask rather than acting as
// a tool in the user's hand, so they live here instead of the left toolbar
// (PS_TOOLBAR_PARITY_PLAN § "Move Out Of The Left Toolbar"). Amount-taking
// ops enter the live preview mode (tuned in Tool options, committed via
// Apply); amount-less ops commit immediately.

import { useContext } from "react";
import { MASK_OPS, maskTool, type MaskTool } from "../maskTools";
import { localizeTool } from "../maskToolsI18n";
import { LangContext } from "../../i18n";
import { isPreviewableOp } from "../maskMorphology";
import { ToolIcon } from "./toolIcons";

interface MaskOpsPanelProps {
  toolId: string;
  onToolClick: (tool: MaskTool) => void;
}

export function MaskOpsPanel({ toolId, onToolClick }: MaskOpsPanelProps) {
  const lang = useContext(LangContext);
  return (
    <div className="mask-panel-body">
      <div className="mask-ops-grid">
        {MASK_OPS.map((id) => {
          const mt = maskTool(id);
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
