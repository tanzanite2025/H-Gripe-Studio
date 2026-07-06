import {
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import { useReactFlow, useStore, useStoreApi } from "@hgripe/flow";
import { paletteGroups, type NodeSpec, type PaletteCategory } from "../graph/nodeSpecs";
import { GROUP_ZH, localizeSpec } from "../graph/nodeSpecsI18n";
import { LangContext, useT, type MsgKey } from "../i18n";

interface PaletteProps {
  /** Click-to-add (node is placed at a default spot on the canvas). */
  onAdd: (kind: string) => void;
  /** Labelled canvas options (own row in the canvas-controls section). */
  showMinimap: boolean;
  setShowMinimap: Dispatch<SetStateAction<boolean>>;
  snapToGrid: boolean;
  setSnapToGrid: Dispatch<SetStateAction<boolean>>;
  onTidyLayout: () => void;
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
const PALETTE_OPEN_KEY = "hgripe.studio.paletteOpenSection.v1";
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

// Icons for the canvas-controls accordion. Paths set their own fill/stroke so
// they render as open strokes rather than filled shapes.
function ZoomInIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 5 V19 M5 12 H19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 12 H19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function FitViewIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      {locked ? (
        <path d="M8 11 V8 a4 4 0 0 1 8 0 V11" fill="none" stroke="currentColor" strokeWidth="2" />
      ) : (
        <path d="M8 11 V8 a4 4 0 0 1 8 0" fill="none" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  );
}

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

function loadOpenSection(): string | null {
  if (typeof window === "undefined") return "source";
  const raw = window.localStorage.getItem(PALETTE_OPEN_KEY);
  if (raw === null) return "source";
  return raw === "" ? null : raw;
}

// Left rail listing the available node kinds. Each item can be dragged onto the
// canvas (drop position is honoured) or clicked to add at a default location.
export function Palette({
  onAdd,
  showMinimap,
  setShowMinimap,
  snapToGrid,
  setSnapToGrid,
  onTidyLayout,
}: PaletteProps) {
  const [width, setWidth] = useState(loadPaletteWidth);
  const [openSection, setOpenSection] = useState<string | null>(loadOpenSection);
  const lang = useContext(LangContext);
  const t = useT();

  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const store = useStoreApi();
  const interactive = useStore(
    (s) => s.nodesDraggable || s.nodesConnectable || s.elementsSelectable,
  );
  const toggleInteractive = () => {
    const next = !interactive;
    store.setState({
      nodesDraggable: next,
      nodesConnectable: next,
      elementsSelectable: next,
    });
  };

  const toggleSection = (key: string) => {
    const next = openSection === key ? null : key;
    setOpenSection(next);
    window.localStorage.setItem(PALETTE_OPEN_KEY, next ?? "");
  };

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
    <aside className="palette" style={{ width }} aria-label={t("palette.heading")}>
      <div
        className="palette-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize node palette"
        title="Drag to resize node palette"
        onPointerDown={startResize}
      />
      <div className="palette-sections">
        {groups.map(({ category, specs }) => {
          const open = openSection === category;
          return (
            <div key={category} className={`palette-group${open ? " open" : ""}`}>
              <button
                type="button"
                className="palette-group-header"
                aria-expanded={open}
                onClick={() => toggleSection(category)}
              >
                <span className="palette-group-title">{t(CATEGORY_LABEL[category])}</span>
                <span className="palette-group-count">{specs.length}</span>
                <span className="palette-group-toggle" aria-hidden="true">
                  {open ? "\u2212" : "+"}
                </span>
              </button>
              {open && (
                <div className="palette-group-body">
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
              )}
            </div>
          );
        })}
        <div className={`palette-group${openSection === "containers" ? " open" : ""}`}>
          <button
            type="button"
            className="palette-group-header"
            aria-expanded={openSection === "containers"}
            onClick={() => toggleSection("containers")}
          >
            <span className="palette-group-title">{t("palette.containers")}</span>
            <span className="palette-group-count">1</span>
            <span className="palette-group-toggle" aria-hidden="true">
              {openSection === "containers" ? "\u2212" : "+"}
            </span>
          </button>
          {openSection === "containers" && (
            <div className="palette-group-body">
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
          )}
        </div>
        <div className={`palette-group${openSection === "controls" ? " open" : ""}`}>
          <button
            type="button"
            className="palette-group-header"
            aria-expanded={openSection === "controls"}
            onClick={() => toggleSection("controls")}
          >
            <span className="palette-group-title">{t("palette.canvasControls")}</span>
            <span className="palette-group-toggle" aria-hidden="true">
              {openSection === "controls" ? "\u2212" : "+"}
            </span>
          </button>
          {openSection === "controls" && (
            <div className="palette-group-body">
              <div className="palette-controls-row">
                <button
                  className="palette-control-button"
                  onClick={() => void zoomIn()}
                  title={t("canvas.zoomIn")}
                  aria-label={t("canvas.zoomIn")}
                >
                  <ZoomInIcon />
                </button>
                <button
                  className="palette-control-button"
                  onClick={() => void zoomOut()}
                  title={t("canvas.zoomOut")}
                  aria-label={t("canvas.zoomOut")}
                >
                  <ZoomOutIcon />
                </button>
                <button
                  className="palette-control-button"
                  onClick={() => void fitView()}
                  title={t("canvas.fitView")}
                  aria-label={t("canvas.fitView")}
                >
                  <FitViewIcon />
                </button>
                <button
                  className={`palette-control-button${interactive ? "" : " active"}`}
                  onClick={toggleInteractive}
                  title={interactive ? t("canvas.lock") : t("canvas.unlock")}
                  aria-label={interactive ? t("canvas.lock") : t("canvas.unlock")}
                  aria-pressed={!interactive}
                >
                  <LockIcon locked={!interactive} />
                </button>
              </div>
              <div className="palette-controls-row palette-controls-labeled">
                <label className="palette-control-toggle" title={t("label.mapTitle")}>
                  <input
                    type="checkbox"
                    checked={showMinimap}
                    onChange={(e) => setShowMinimap(e.target.checked)}
                  />
                  {t("label.map")}
                </label>
                <label className="palette-control-toggle" title={t("label.snapTitle")}>
                  <input
                    type="checkbox"
                    checked={snapToGrid}
                    onChange={(e) => setSnapToGrid(e.target.checked)}
                  />
                  {t("label.snap")}
                </label>
                <button
                  type="button"
                  className="palette-control-text-button"
                  onClick={onTidyLayout}
                  title={t("btn.tidyTitle")}
                >
                  {t("btn.tidy")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
