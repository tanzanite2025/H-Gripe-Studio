// Left toolbar: PS-style single icon column. Tools are grouped into slots
// (see MASK_TOOL_SLOTS); a multi-tool slot shows its last-used variant and
// opens a flyout card of the variants on long-press / right-click, like the
// Photoshop toolbar.

import { useContext, useEffect, useRef, useState } from "react";
import { MASK_TOOL_SLOTS, maskTool, type MaskTool } from "../maskTools";
import { localizeTool } from "../maskToolsI18n";
import { comboLabel } from "../../shortcuts";
import { toolCombo } from "../../shortcuts/scopes/maskEdit";
import { LangContext } from "../../i18n";
import { isPreviewableOp } from "../maskMorphology";
import { ToolIcon } from "./toolIcons";

interface MaskToolbarProps {
  toolId: string;
  onToolClick: (tool: MaskTool) => void;
}

const LONG_PRESS_MS = 350;

function isActive(mt: MaskTool, toolId: string): boolean {
  return toolId === mt.id && (mt.kind !== "global" || isPreviewableOp(mt.id));
}

export function MaskToolbar({ toolId, onToolClick }: MaskToolbarProps) {
  const lang = useContext(LangContext);
  // Which slot's flyout card is open ("si-gi" key) and where it anchors.
  // The card renders `position: fixed` so the scrollable toolbar column
  // can't clip it.
  const [flyout, setFlyout] = useState<{ key: string; left: number; top: number } | null>(null);
  // Last-used variant per multi-tool slot (the icon shown on the button).
  const [faces, setFaces] = useState<Record<string, string>>({});
  const pressTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    if (!flyout) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFlyout(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [flyout]);

  const clearTimer = () => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const pick = (key: string, mt: MaskTool) => {
    setFaces((f) => ({ ...f, [key]: mt.id }));
    setFlyout(null);
    onToolClick(mt);
  };

  return (
    <div className="mask-edit-tools">
      {MASK_TOOL_SLOTS.map((section, si) => (
        <div key={si} className="mask-tool-group">
          {section.map((slot, gi) => {
            const key = `${si}-${gi}`;
            const tools = slot.map((id) => maskTool(id)).filter((mt): mt is MaskTool => mt != null);
            if (tools.length === 0) return null;
            // Face: the active tool if it lives here, else the remembered
            // last-used variant, else the slot's first tool.
            const face =
              tools.find((mt) => mt.id === toolId) ??
              tools.find((mt) => mt.id === faces[key]) ??
              tools[0];
            const loc = localizeTool(face, lang);
            const combo = toolCombo(face.id);
            const hint = combo ? `${loc.hint} (${comboLabel(combo)})` : loc.hint;
            const active = tools.some((mt) => isActive(mt, toolId));
            return (
              <div key={key} className="mask-tool-slot">
                <button
                  className={`mask-tool ${active ? "active" : ""}`}
                  title={hint}
                  aria-label={loc.label}
                  onPointerDown={(e) => {
                    if (tools.length < 2) return;
                    suppressClick.current = false;
                    clearTimer();
                    const rect = e.currentTarget.getBoundingClientRect();
                    pressTimer.current = window.setTimeout(() => {
                      suppressClick.current = true;
                      setFlyout({ key, left: rect.right + 4, top: rect.top });
                    }, LONG_PRESS_MS);
                  }}
                  onPointerUp={clearTimer}
                  onPointerLeave={clearTimer}
                  onContextMenu={(e) => {
                    if (tools.length < 2) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setFlyout(flyout?.key === key ? null : { key, left: rect.right + 4, top: rect.top });
                  }}
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    setFlyout(null);
                    onToolClick(face);
                  }}
                >
                  <ToolIcon id={face.id} />
                  {tools.length > 1 ? <span className="flyout-corner" aria-hidden="true" /> : null}
                </button>
                {flyout?.key === key ? (
                  <>
                    <div className="mask-flyout-backdrop" onClick={() => setFlyout(null)} onContextMenu={(e) => { e.preventDefault(); setFlyout(null); }} />
                    <div className="mask-flyout" role="menu" style={{ left: flyout.left, top: flyout.top }}>
                      {tools.map((mt) => {
                        const mloc = localizeTool(mt, lang);
                        const mcombo = toolCombo(mt.id);
                        return (
                          <button
                            key={mt.id}
                            role="menuitem"
                            className={`mask-flyout-item ${isActive(mt, toolId) ? "active" : ""}`}
                            title={mloc.hint}
                            onClick={() => pick(key, mt)}
                          >
                            <ToolIcon id={mt.id} />
                            <span className="label">{mloc.label}</span>
                            {mcombo ? <em className="combo">{comboLabel(mcombo)}</em> : null}
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
