// Right-click context menu for the canvas: menu open state (node vs. empty
// pane) and the item list built from the editing actions passed in. Image
// source cards additionally get the auto (computed) bound-edit entries.

import { useCallback, useMemo, useState, type MutableRefObject } from "react";
import type { Edge, Node } from "@xyflow/react";

import type { MenuItem } from "./ContextMenu";
import type { Clip } from "./clipboard";
import type { HgripeNodeData } from "./HgripeNode";
import { LOWERED_CARD_ROWS } from "../graph/lowering";
import { useT } from "../i18n";

export interface UseContextMenuArgs {
  nodes: Node[];
  edges: Edge[];
  clipboard: MutableRefObject<Clip | null>;
  fitView: (opts?: { padding?: number; duration?: number }) => Promise<boolean>;
  addBoundEdit: (
    sourceId: string,
    editKind: string,
    opts?: { params?: Record<string, unknown>; openEditor?: boolean; run?: boolean },
  ) => void;
  duplicateNode: (id: string) => void;
  disconnectNode: (id: string) => void;
  deleteNode: (id: string) => void;
  tidyLayout: () => void;
  pasteClipboard: () => void;
  /** Run the node + its upstream chain (RunScope `node_upstream`). */
  runUpToNode?: (nodeId: string) => void;
  /** Run an integrated card + upstream (RunScope `card`). */
  runCard?: (nodeId: string) => void;
  /** Run the node and everything downstream of it (RunScope `node_downstream`). */
  runNodeDownstream?: (nodeId: string) => void;
}

export function useContextMenu({
  nodes,
  edges,
  clipboard,
  fitView,
  addBoundEdit,
  duplicateNode,
  disconnectNode,
  deleteNode,
  tidyLayout,
  pasteClipboard,
  runUpToNode,
  runCard,
  runNodeDownstream,
}: UseContextMenuArgs) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string | null } | null>(null);

  const openNodeMenu = useCallback(
    (nodeId: string, at: { x: number; y: number }) => setMenu({ ...at, nodeId }),
    [],
  );
  const openPaneMenu = useCallback(
    (at: { x: number; y: number }) => setMenu({ ...at, nodeId: null }),
    [],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  // Right-click menu items, depending on whether a node or empty pane was hit.
  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return [];
    if (menu.nodeId) {
      const id = menu.nodeId;
      const connected = edges.some((e) => e.source === id || e.target === id);
      const kind = (nodes.find((n) => n.id === id)?.data as HgripeNodeData | undefined)?.kind;
      const items: MenuItem[] = [];
      // Scoped run commands (RUN_SCOPE_AND_EXECUTION_AFFORDANCE_PLAN, "Context
      // Menu"): run-to-here on every node, run-card on integrated cards, and
      // the explicit downstream run (downstream never runs implicitly).
      if (runUpToNode)
        items.push({ label: t("menu.runToHere"), onClick: () => runUpToNode(id) });
      if (runCard && kind && kind in LOWERED_CARD_ROWS)
        items.push({ label: t("menu.runCard"), onClick: () => runCard(id) });
      if (runNodeDownstream)
        items.push({ label: t("menu.runDownstream"), onClick: () => runNodeDownstream(id) });
      // Auto (computed) entries: image cards spawn a bound compute node and run
      // it straight away — no editor. Each is purely algorithm-derived from the
      // single input image (the manual / human-spatial lanes live on the card's
      // action-row buttons instead). See generic-media-card.md.
      if (kind === "imageSource") {
        const auto = (editKind: string, params?: Record<string, unknown>) =>
          addBoundEdit(id, editKind, { params, openEditor: false, run: true });
        items.push(
          { label: t("node.enhanceAuto"), onClick: () => auto("imageEnhance") },
          { label: t("node.watchdogAuto"), onClick: () => auto("detailWatchdog") },
        );
      }
      items.push(
        { label: "复制", onClick: () => duplicateNode(id) },
        { label: "断开全部连线", onClick: () => disconnectNode(id), disabled: !connected },
        { label: "删除", onClick: () => deleteNode(id) },
      );
      return items;
    }
    return [
      { label: "整理布局", onClick: tidyLayout },
      { label: "适应视图", onClick: () => fitView({ padding: 0.2, duration: 300 }) },
      { label: "粘贴", onClick: pasteClipboard, disabled: !clipboard.current },
    ];
  }, [
    menu,
    edges,
    nodes,
    t,
    addBoundEdit,
    duplicateNode,
    disconnectNode,
    deleteNode,
    tidyLayout,
    fitView,
    pasteClipboard,
    clipboard,
    runUpToNode,
    runCard,
    runNodeDownstream,
  ]);

  return { menu, menuItems, openNodeMenu, openPaneMenu, closeMenu };
}
