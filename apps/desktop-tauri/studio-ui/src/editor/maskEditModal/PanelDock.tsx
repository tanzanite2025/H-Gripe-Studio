import type { DragEvent, ReactNode } from "react";

// One tab page of a dock group: the tab label (may carry a live count) and
// the panel rendered while the tab is active.
export interface DockPanel<Id extends string = string> {
  id: Id;
  label: ReactNode;
  content: ReactNode;
}

const TAB_MIME = "application/x-hgripe-dock-tab";

interface PanelDockProps<Id extends string> {
  panels: DockPanel<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Let this group absorb the rail's remaining height (PS's Layers dock). */
  grow?: boolean;
  /** Hide the tab strip for single-purpose groups whose title duplicates the content. */
  hideTabs?: boolean;
  className?: string;
  /**
   * PS tab docking: a tab (from this or any other group) was dropped at
   * `index` of this group's strip. Omit to disable dragging.
   */
  onTabDrop?: (id: string, index: number) => void;
}

/**
 * A PS-style tabbed dock group: a dark tab strip over a body that shows one
 * panel at a time. The right rail is composed of these — new panels register
 * as `DockPanel` entries instead of adding bespoke tab markup. Render-only:
 * the tab layout lives in `dockLayout.ts` and is wired by the modal.
 */
export function PanelDock<Id extends string>({
  panels,
  active,
  onSelect,
  grow,
  hideTabs,
  className,
  onTabDrop,
}: PanelDockProps<Id>) {
  const current = panels.find((p) => p.id === active) ?? panels[0];
  const allowDrop = (e: DragEvent) => {
    if (onTabDrop && e.dataTransfer.types.includes(TAB_MIME)) e.preventDefault();
  };
  const dropAt = (e: DragEvent, index: number) => {
    if (!onTabDrop) return;
    const id = e.dataTransfer.getData(TAB_MIME);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    onTabDrop(id, index);
  };
  return (
    <div className={`mask-panel-group${grow ? " grow" : ""}${hideTabs ? " no-tabs" : ""}${className ? ` ${className}` : ""}`}>
      {hideTabs ? null : (
        <div className="mask-panel-tabs" role="tablist" onDragOver={allowDrop} onDrop={(e) => dropAt(e, panels.length)}>
          {panels.map((p, i) => (
            <button
              key={p.id}
              role="tab"
              className={p.id === active ? "active" : ""}
              draggable={!!onTabDrop}
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, p.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={allowDrop}
              onDrop={(e) => dropAt(e, i)}
              onClick={() => onSelect(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="mask-panel-group-body">{current?.content}</div>
    </div>
  );
}
