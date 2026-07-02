import type { ReactNode } from "react";

// One tab page of a dock group: the tab label (may carry a live count) and
// the panel rendered while the tab is active.
export interface DockPanel<Id extends string = string> {
  id: Id;
  label: ReactNode;
  content: ReactNode;
}

interface PanelDockProps<Id extends string> {
  panels: DockPanel<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Let this group absorb the rail's remaining height (PS's Layers dock). */
  grow?: boolean;
}

/**
 * A PS-style tabbed dock group: a dark tab strip over a body that shows one
 * panel at a time. The right rail is composed of these — new panels register
 * as `DockPanel` entries instead of adding bespoke tab markup.
 */
export function PanelDock<Id extends string>({ panels, active, onSelect, grow }: PanelDockProps<Id>) {
  const current = panels.find((p) => p.id === active) ?? panels[0];
  return (
    <div className={`mask-panel-group${grow ? " grow" : ""}`}>
      <div className="mask-panel-tabs" role="tablist">
        {panels.map((p) => (
          <button key={p.id} role="tab" className={p.id === active ? "active" : ""} onClick={() => onSelect(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="mask-panel-group-body">{current?.content}</div>
    </div>
  );
}
