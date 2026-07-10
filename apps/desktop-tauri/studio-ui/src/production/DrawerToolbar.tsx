import { useT, type MsgKey } from "../i18n";
import type { AddableAsset } from "./MediaWorkspacePopover";
import { MediaWorkspacePopover } from "./MediaWorkspacePopover";
import type { MediaAsset } from "./mediaBin";

export type TimelineTool = "select" | "razor" | "hand";

const TIMELINE_TOOLS: Array<{ id: TimelineTool; labelKey: MsgKey }> = [
  { id: "select", labelKey: "drawer.timelineToolSelect" },
  { id: "razor", labelKey: "drawer.timelineToolRazor" },
  { id: "hand", labelKey: "drawer.timelineToolHand" },
];

interface DrawerToolbarProps {
  assets: MediaAsset[];
  activeAssetId: string | null;
  addableAsset: AddableAsset | null;
  assetPanelOpen: boolean;
  onAssetPanelOpenChange: (open: boolean) => void;
  onAddSelected: () => void;
  onImportMedia?: () => void;
  onSelectAsset: (assetId: string | null) => void;
  onRemoveAsset: (assetId: string) => void;
  onOpenImageEdit: (assetId: string) => void;
  onDragAssetChange: (assetId: string | null) => void;
  onOpenExport: () => void;
  exportDisabled: boolean;
  timelineTool: TimelineTool;
  onTimelineToolChange: (tool: TimelineTool) => void;
}

function AssetBinIcon() {
  return (
    <svg className="production-asset-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7.5h5l1.4 2H20v8.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M4 7.5V6a2 2 0 0 1 2-2h3.2l1.4 2H18a2 2 0 0 1 2 2v1.5" />
      <path d="M8 14h8" />
      <path d="M8 17h5" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg className="production-asset-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function TimelineToolIcon({ tool }: { tool: TimelineTool }) {
  return (
    <svg className="production-timeline-tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {tool === "select" ? (
        <path d="M6 4l11 8-5 1.2 3.2 5.6-2.8 1.6-3.1-5.5L6 18z" />
      ) : tool === "razor" ? (
        <>
          <path d="m5 18 12-12 2 2L7 20z" />
          <path d="m14 9 3 3" />
          <path d="M4 4h5" />
        </>
      ) : (
        <>
          <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11" />
          <path d="M11 11V5.5a1.5 1.5 0 0 1 3 0V11" />
          <path d="M14 11V7a1.5 1.5 0 0 1 3 0v7.5c0 3-2.2 5.5-5.5 5.5H10c-2.3 0-3.6-1.1-4.8-3.1L4 14.8a1.6 1.6 0 0 1 2.7-1.7L8 15" />
        </>
      )}
    </svg>
  );
}

export function DrawerToolbar({
  assets,
  activeAssetId,
  addableAsset,
  assetPanelOpen,
  onAssetPanelOpenChange,
  onAddSelected,
  onImportMedia,
  onSelectAsset,
  onRemoveAsset,
  onOpenImageEdit,
  onDragAssetChange,
  onOpenExport,
  exportDisabled,
  timelineTool,
  onTimelineToolChange,
}: DrawerToolbarProps) {
  const t = useT();

  return (
    <>
      <div className="production-asset-side">
        <div className="production-side-actions">
          <button
            type="button"
            className={`production-asset-toggle${assetPanelOpen ? " active" : ""}`}
            onClick={() => onAssetPanelOpenChange(!assetPanelOpen)}
            title={t("drawer.binTitle")}
            aria-label={t("drawer.binTitle")}
          >
            <AssetBinIcon />
            <span className="production-asset-count">{assets.length}</span>
          </button>
          <button
            type="button"
            className="production-asset-toggle production-export-toggle"
            onClick={onOpenExport}
            disabled={exportDisabled}
            title={t("drawer.exportTitle")}
            aria-label={t("drawer.exportTitle")}
          >
            <ExportIcon />
          </button>
        </div>
        <div
          className="production-timeline-tools production-timeline-side-tools"
          role="toolbar"
          aria-label="Timeline tools"
        >
          {TIMELINE_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={`production-timeline-tool${timelineTool === tool.id ? " active" : ""}`}
              onClick={() => onTimelineToolChange(tool.id)}
              title={t(tool.labelKey)}
              aria-label={t(tool.labelKey)}
              aria-pressed={timelineTool === tool.id}
            >
              <TimelineToolIcon tool={tool.id} />
            </button>
          ))}
        </div>
      </div>
      {assetPanelOpen ? (
        <div className="production-bin-popover-shell">
          <MediaWorkspacePopover
            assets={assets}
            activeAssetId={activeAssetId}
            addableAsset={addableAsset}
            onAddSelected={onAddSelected}
            onImportMedia={onImportMedia}
            onClose={() => onAssetPanelOpenChange(false)}
            onSelectAsset={onSelectAsset}
            onRemoveAsset={onRemoveAsset}
            onOpenImageEdit={onOpenImageEdit}
            onDragAssetChange={onDragAssetChange}
          />
        </div>
      ) : null}
    </>
  );
}
