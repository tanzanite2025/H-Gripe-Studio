import { useContext, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { paletteGroups, type NodeSpec, type PaletteCategory } from "../graph/nodeSpecs";
import { GROUP_ZH, localizeSpec } from "../graph/nodeSpecsI18n";
import { LangContext, useT, type MsgKey } from "../i18n";

interface PaletteProps {
  /** Click-to-add (node is placed at a default spot on the canvas). */
  onAdd: (kind: string) => void;
}

// `internal` primitives never appear in the palette, so they carry no label.
const CATEGORY_LABEL: Record<PaletteCategory, MsgKey> = {
  source: "palette.catSource",
  generate: "palette.catGenerate",
  process: "palette.catProcess",
  review: "palette.catReview",
  workflow: "palette.catWorkflow",
  output: "palette.catOutput",
};

// Local vs API badge shown on palette items so the two kinds of card are
// visually separated. Pure `graph` nodes carry no badge.
const EXECUTOR_BADGE: Partial<Record<NodeSpec["executor"], string>> = {
  local: "Local",
  api: "API",
  hybrid: "Local/API",
};

// MIME-ish key carried on drag so the canvas knows which node kind to create.
export const DND_NODE_KIND = "application/hgripe-node-kind";
const PALETTE_WIDTH_KEY = "hgripe.studio.paletteWidth.v1";
const PALETTE_MIN_WIDTH = 184;
const PALETTE_MAX_WIDTH = 360;
const PALETTE_DEFAULT_WIDTH = 220;

// The Group container is not in NODE_SPECS' palette groups; describe it here so
// it participates in search alongside the catalogue.
const GROUP_ITEM = {
  kind: "group",
  title: "Group",
  description: "A resizable frame. Drag nodes inside to group them; members move together.",
};

export function matches(spec: { title: string; kind: string; description: string }, q: string): boolean {
  if (!q) return true;
  const hay = `${spec.title} ${spec.kind} ${spec.description}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

function clampPaletteWidth(width: number) {
  return Math.min(PALETTE_MAX_WIDTH, Math.max(PALETTE_MIN_WIDTH, Math.round(width)));
}

function loadPaletteWidth() {
  if (typeof window === "undefined") return PALETTE_DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(PALETTE_WIDTH_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? clampPaletteWidth(parsed) : PALETTE_DEFAULT_WIDTH;
}

// Left rail listing the available node kinds. Each item can be dragged onto the
// canvas (drop position is honoured) or clicked to add at a default location.
export function Palette({ onAdd }: PaletteProps) {
  const [width, setWidth] = useState(loadPaletteWidth);
  const lang = useContext(LangContext);
  const t = useT();

  const setPaletteWidth = (next: number) => {
    const clamped = clampPaletteWidth(next);
    setWidth(clamped);
    window.localStorage.setItem(PALETTE_WIDTH_KEY, String(clamped));
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      setPaletteWidth(startWidth + moveEvent.clientX - startX);
    };
    const onPointerUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const groups = useMemo(
    () =>
      paletteGroups().map(({ category, specs }) => ({
        category,
        specs: specs.map((s) => localizeSpec(s, lang)),
      })),
    [lang],
  );

  return (
    <aside className="palette" style={{ width }}>
      <div
        className="palette-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize node palette"
        title="Drag to resize node palette"
        onPointerDown={startResize}
      />
      <h2>{t("palette.heading")}</h2>
      {groups.map(({ category, specs }) => (
        <div key={category} className="palette-group">
          <h3>{t(CATEGORY_LABEL[category])}</h3>
          {specs.map((spec) => (
            <button
              key={spec.kind}
              className="palette-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_NODE_KIND, spec.kind);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onAdd(spec.kind)}
              title={`${spec.title} - ${spec.description}`}
            >
              <span className="palette-item-title">{spec.title}</span>
              {EXECUTOR_BADGE[spec.executor] && (
                <span className={`palette-badge palette-badge-${spec.executor}`}>
                  {EXECUTOR_BADGE[spec.executor]}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
      <div className="palette-group">
        <h3>{t("palette.containers")}</h3>
        <button
          className="palette-item"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DND_NODE_KIND, "group");
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => onAdd("group")}
          title={`${t("palette.group")} - ${lang === "zh" ? GROUP_ZH.description : GROUP_ITEM.description}`}
        >
          {t("palette.group")}
        </button>
      </div>
      <p className="muted palette-hint">{t("palette.hint")}</p>
    </aside>
  );
}
