// Left toolbar: PS-ordered tool groups with separators (see MASK_TOOL_GROUPS).

import { useContext } from "react";
import { MASK_TOOL_GROUPS, maskTool, type MaskTool } from "../maskTools";
import { localizeTool } from "../maskToolsI18n";
import { comboLabel } from "../../shortcuts";
import { toolCombo } from "../../shortcuts/scopes/maskEdit";
import { LangContext, useT } from "../../i18n";
import { isPreviewableOp } from "../maskMorphology";

interface MaskToolbarProps {
  toolId: string;
  onToolClick: (tool: MaskTool) => void;
}

export function MaskToolbar({ toolId, onToolClick }: MaskToolbarProps) {
  const t = useT();
  const lang = useContext(LangContext);
  return (
    <div className="mask-edit-tools">
      {MASK_TOOL_GROUPS.map((group, gi) => (
        <div key={gi} className="mask-tool-group">
          {group.map((id) => maskTool(id)).filter((mt): mt is MaskTool => mt != null).map((mt) => {
            const loc = localizeTool(mt, lang);
            const combo = toolCombo(mt.id);
            const hint = combo ? `${loc.hint} (${comboLabel(combo)})` : loc.hint;
            return (
              <button
                key={mt.id}
                className={`mask-tool ${mt.status === "planned" ? "planned" : ""} ${toolId === mt.id && (mt.kind !== "global" || isPreviewableOp(mt.id)) ? "active" : ""}`}
                disabled={mt.status === "planned"}
                title={mt.status === "planned" ? `${hint}（${t("mask.comingSoon")}）` : hint}
                onClick={() => onToolClick(mt)}
              >
                {loc.label}
                {combo ? <em className="combo">{comboLabel(combo)}</em> : null}
                {mt.status === "planned" ? <em className="soon">{t("mask.soon")}</em> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
