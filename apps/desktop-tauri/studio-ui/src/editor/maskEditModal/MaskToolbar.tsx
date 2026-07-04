// Left toolbar: PS-style single icon column. Tools are grouped into
// Photoshop slots (see PS_TOOL_SECTIONS); a multi-tool slot shows its
// last-used variant and opens a flyout card of the variants on long-press /
// right-click, like the Photoshop toolbar. Planned variants render greyed
// and disabled, holding the PS slot shape. Each button carries its PS
// shortcut letter as a corner badge (from the mask-edit scope's `toolCombo`
// table, falling back to the slot's reserved PS letter) alongside the
// tooltip.

import { useContext, useEffect, useRef, useState } from "react";
import { PS_TOOL_SECTIONS, maskTool, type MaskTool } from "../maskTools";
import { localizeTool } from "../maskToolsI18n";
import { comboLabel, parseCombo } from "../../shortcuts";
import { toolCombo } from "../../shortcuts/scopes/maskEdit";
import { LangContext, useT } from "../../i18n";
import { isPreviewableOp } from "../maskMorphology";
import { ToolIcon } from "./toolIcons";

interface MaskToolbarProps {
  toolId: string;
  onToolClick: (tool: MaskTool) => void;
  /** Last-used variant per multi-tool slot (the icon shown on the button). */
  faces: Record<string, string>;
  /** A flyout variant was picked: remember it as slot `slotId`'s face. */
  onPickFace: (slotId: string, toolId: string) => void;
  /** Paint polarity for the colour wells: add paints mask in (white front). */
  paintMode: "add" | "subtract";
  /** Swap paint polarity (PS X). */
  onSwapColors: () => void;
  /** Back to default polarity / target (PS D). */
  onResetColors: () => void;
}

const LONG_PRESS_MS = 350;

/** The single key of a tool's combo, for the corner badge ("M" for `shift+m`). */
function comboBadge(combo: string): string {
  const key = parseCombo(combo).key;
  return key.length === 1 ? key.toUpperCase() : "";
}

function isActive(mt: MaskTool, toolId: string): boolean {
  return toolId === mt.id && (mt.kind !== "global" || isPreviewableOp(mt.id));
}

export function MaskToolbar({ toolId, onToolClick, faces, onPickFace, paintMode, onSwapColors, onResetColors }: MaskToolbarProps) {
  const t = useT();
  const lang = useContext(LangContext);
  // Which slot's flyout card is open ("si-gi" key) and where it anchors.
  // The card renders `position: fixed` so the scrollable toolbar column
  // can't clip it.
  const [flyout, setFlyout] = useState<{ key: string; left: number; top: number } | null>(null);
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

  // A long-press timer must not survive unmount (it would set state on a
  // disposed component).
  useEffect(() => clearTimer, []);

  const pick = (key: string, mt: MaskTool) => {
    if (mt.status !== "ready") return;
    onPickFace(key, mt.id);
    setFlyout(null);
    onToolClick(mt);
  };

  return (
    <div className="mask-edit-tools">
      {PS_TOOL_SECTIONS.map((section, si) => (
        <div key={si} className="mask-tool-group">
          {section.map((slot) => {
            const key = slot.id;
            const tools = slot.variants.map((id) => maskTool(id)).filter((mt): mt is MaskTool => mt != null);
            if (tools.length === 0) return null;
            const readyTools = tools.filter((mt) => mt.status === "ready");
            // Face: the active tool if it lives here, else the remembered
            // last-used variant, else the slot's first ready tool, else its
            // first (all-planned slots show their leading variant, greyed).
            const face =
              tools.find((mt) => mt.id === toolId) ??
              readyTools.find((mt) => mt.id === faces[key]) ??
              readyTools[0] ??
              tools[0];
            const facePlanned = face.status !== "ready";
            const loc = localizeTool(face, lang);
            const combo = toolCombo(face.id);
            const hint = combo ? `${loc.hint} (${comboLabel(combo)})` : loc.hint;
            const badge = combo ? comboBadge(combo) : slot.shortcut ?? "";
            const active = tools.some((mt) => isActive(mt, toolId));
            return (
              <div key={key} className="mask-tool-slot">
                <button
                  className={`mask-tool ${active ? "active" : ""} ${facePlanned ? "planned" : ""}`}
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
                  {badge ? (
                    <kbd className="mask-tool-key" aria-hidden="true">{badge}</kbd>
                  ) : null}
                  {tools.length > 1 ? <span className="flyout-corner" aria-hidden="true" /> : null}
                </button>
                {flyout?.key === key ? (
                  <>
                    <div className="mask-flyout-backdrop" onClick={() => setFlyout(null)} onContextMenu={(e) => { e.preventDefault(); setFlyout(null); }} />
                    <div className="mask-flyout" role="menu" style={{ left: flyout.left, top: flyout.top }}>
                      {tools.map((mt) => {
                        const mloc = localizeTool(mt, lang);
                        // PS flyouts show the slot letter on every variant row.
                        const mcombo = toolCombo(mt.id) ?? slot.shortcut?.toLowerCase();
                        const planned = mt.status !== "ready";
                        return (
                          <button
                            key={mt.id}
                            role="menuitem"
                            className={`mask-flyout-item ${isActive(mt, toolId) ? "active" : ""} ${planned ? "planned" : ""}`}
                            title={mcombo ? `${mloc.hint} (${comboLabel(mcombo)})` : mloc.hint}
                            aria-disabled={planned || undefined}
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
      {/* PS-style colour wells: in a grayscale mask the "foreground" is the
          paint polarity — white adds, black erases. X swaps, D resets. */}
      <div className="mask-color-wells">
        <button
          className="mask-color-reset"
          title={`${t("mask.colorReset")} (D)`}
          aria-label={t("mask.colorReset")}
          onClick={onResetColors}
        >
          <span className="well back dark" />
          <span className="well front light" />
        </button>
        <button
          className="mask-color-swap"
          title={`${t("mask.colorSwap")} (X)`}
          aria-label={t("mask.colorSwap")}
          onClick={onSwapColors}
        >
          ⇄
        </button>
        <div className="mask-color-main" title={paintMode === "add" ? t("mask.colorAdd") : t("mask.colorSubtract")}>
          <span className={`well back ${paintMode === "add" ? "dark" : "light"}`} />
          <span className={`well front ${paintMode === "add" ? "light" : "dark"}`} />
        </div>
      </div>
    </div>
  );
}
