import { useT, type MsgKey } from "../i18n";
import { GradePanel } from "../editor/GradePanel";
import type { DrawerMode, DrawerTab } from "./drawerState";
import type { MediaAsset, MediaAssetKind } from "./mediaBin";
import { targetKey, type ProductionTarget } from "./productionTarget";
import { timelineDuration, trackEnd, type TimelineModel } from "./timeline";

export interface AddableAsset {
  kind: MediaAssetKind;
  path: string;
  sourceNodeId: string;
}

export interface ProductionDrawerProps {
  mode: DrawerMode;
  onSetMode: (mode: DrawerMode) => void;
  tab: DrawerTab;
  onSetTab: (tab: DrawerTab) => void;
  /** Current unified production selection (drawer + on-demand editors). */
  target: ProductionTarget | null;
  assets: MediaAsset[];
  /** Asset id currently selected in the bin (targets `{kind:"asset"}`). */
  activeAssetId: string | null;
  onSelectAsset: (assetId: string | null) => void;
  onRemoveAsset: (assetId: string) => void;
  /** The selected canvas node as a bin-addable media reference, when it is one. */
  addableAsset: AddableAsset | null;
  onAddSelected: () => void;
  timeline: TimelineModel;
  selectedClipId: string | null;
  onSelectClip: (clipId: string | null) => void;
  /** Append the active bin asset as a clip at the end of a compatible track. */
  onAddActiveToTimeline: () => void;
  onRemoveClip: (clipId: string) => void;
  /** Image path the Grade tab previews for the current target, when resolvable. */
  gradeImagePath: string | null;
  /** Video whose frame the Grade tab previews for video-clip targets. */
  gradeVideoPath: string | null;
  /** The current target's stored grade doc (JSON string), if any. */
  gradeDoc: string | null;
  onGradeCommit: (gradeDoc: string) => void;
}

function kindKey(kind: MediaAssetKind): MsgKey {
  return kind === "image" ? "drawer.kindImage" : kind === "video" ? "drawer.kindVideo" : "drawer.kindAudio";
}

/**
 * Bottom production drawer (UNIFIED_PRODUCTION_DRAWER_PLAN.md): the resident
 * edit/grade workspace under the node canvas. Only two first-level tabs live
 * here — Edit / Timeline and Grade; image / audio / export editors open on
 * demand from the workspace selection instead of mounting with the drawer.
 * Collapses to a slim rail so the canvas keeps its space when unused.
 */
export function ProductionDrawer({
  mode,
  onSetMode,
  tab,
  onSetTab,
  target,
  assets,
  activeAssetId,
  onSelectAsset,
  onRemoveAsset,
  addableAsset,
  onAddSelected,
  timeline,
  selectedClipId,
  onSelectClip,
  onAddActiveToTimeline,
  onRemoveClip,
  gradeImagePath,
  gradeVideoPath,
  gradeDoc,
  onGradeCommit,
}: ProductionDrawerProps) {
  const t = useT();

  if (mode === "collapsed") {
    return (
      <div className="production-drawer production-drawer-rail">
        <button
          className="production-drawer-handle"
          onClick={() => onSetMode("half")}
          title={t("drawer.openTitle")}
        >
          ▴ {t("drawer.title")}
        </button>
        <span className="production-drawer-rail-meta">
          {t("drawer.assetCount", { n: assets.length })}
        </span>
      </div>
    );
  }

  const clipAssetName = (clipId: string): string => {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return assets.find((a) => a.id === clip.assetId)?.name ?? clip.assetId;
    }
    return clipId;
  };

  const targetLabel = !target
    ? t("drawer.targetNone")
    : target.kind === "asset"
      ? `${t("drawer.targetAsset")} · ${assets.find((a) => a.id === target.assetId)?.name ?? target.assetId}`
      : target.kind === "node_output"
        ? `${t("drawer.targetNode")} · ${target.nodeId}`
        : target.kind === "video_clip"
          ? `${t("drawer.targetVideoClip")} · ${clipAssetName(target.clipId)}`
          : target.kind === "audio_clip"
            ? `${t("drawer.targetAudioClip")} · ${clipAssetName(target.clipId)}`
            : target.kind;

  return (
    <div className={`production-drawer production-drawer-${mode}`}>
      <div className="production-drawer-head">
        <div className="production-drawer-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "edit"}
            className={tab === "edit" ? "active" : ""}
            onClick={() => onSetTab("edit")}
          >
            {t("drawer.tabEdit")}
          </button>
          <button
            role="tab"
            aria-selected={tab === "grade"}
            className={tab === "grade" ? "active" : ""}
            onClick={() => onSetTab("grade")}
          >
            {t("drawer.tabGrade")}
          </button>
        </div>
        <span className="production-drawer-target" title={targetLabel}>
          {targetLabel}
        </span>
        <div className="spacer" />
        <button
          onClick={() => onSetMode(mode === "half" ? "full" : "half")}
          title={mode === "half" ? t("drawer.fullTitle") : t("drawer.halfTitle")}
        >
          {mode === "half" ? "⤢" : "⤡"}
        </button>
        <button onClick={() => onSetMode("collapsed")} title={t("drawer.collapseTitle")}>
          ▾
        </button>
      </div>

      {tab === "edit" ? (
        <div className="production-drawer-body production-edit">
          <div className="production-bin">
            <div className="production-bin-head">
              <h3>{t("drawer.binTitle")}</h3>
              <div className="spacer" />
              <button
                onClick={onAddSelected}
                disabled={!addableAsset}
                title={t("drawer.addSelectedTitle")}
              >
                {t("drawer.addSelected")}
              </button>
            </div>
            {assets.length === 0 ? (
              <p className="production-bin-empty">{t("drawer.binEmpty")}</p>
            ) : (
              <ul className="production-bin-list">
                {assets.map((a) => (
                  <li key={a.id} className={a.id === activeAssetId ? "active" : ""}>
                    <button
                      className="production-bin-item"
                      onClick={() => onSelectAsset(a.id === activeAssetId ? null : a.id)}
                      title={a.path}
                    >
                      <span className={`production-bin-kind kind-${a.kind}`}>{t(kindKey(a.kind))}</span>
                      <span className="production-bin-name">{a.name}</span>
                    </button>
                    <button
                      className="production-bin-remove"
                      onClick={() => onRemoveAsset(a.id)}
                      title={t("drawer.removeTitle")}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="production-timeline">
            <div className="production-timeline-head">
              <h3>{t("drawer.timelineTitle")}</h3>
              <span className="production-timeline-duration">
                {t("drawer.timelineDuration", { s: timelineDuration(timeline).toFixed(1) })}
              </span>
              <div className="spacer" />
              <button
                onClick={onAddActiveToTimeline}
                disabled={!activeAssetId}
                title={t("drawer.addToTimelineTitle")}
              >
                {t("drawer.addToTimeline")}
              </button>
            </div>
            {timeline.tracks.every((track) => track.clips.length === 0) ? (
              <p className="production-timeline-empty">{t("drawer.timelineEmpty")}</p>
            ) : null}
            <div className="production-timeline-tracks">
              {timeline.tracks.map((track) => {
                // Scale every lane to the same overall timeline length so clip
                // positions line up vertically across tracks.
                const total = Math.max(timelineDuration(timeline), Math.max(trackEnd(track), 1));
                return (
                  <div key={track.id} className="production-track">
                    <span className={`production-track-label track-${track.kind}`}>
                      {track.kind === "video" ? t("drawer.trackVideo") : t("drawer.trackAudio")}
                    </span>
                    <div className="production-track-lane">
                      {track.clips.map((clip) => {
                        const selected = clip.id === selectedClipId;
                        return (
                          <button
                            key={clip.id}
                            className={`production-clip clip-${clip.kind}${selected ? " active" : ""}`}
                            style={{
                              left: `${(clip.start / total) * 100}%`,
                              width: `${(clip.duration / total) * 100}%`,
                            }}
                            onClick={() => onSelectClip(selected ? null : clip.id)}
                            title={`${clipAssetName(clip.id)} · ${clip.start.toFixed(1)}s → ${(clip.start + clip.duration).toFixed(1)}s`}
                          >
                            <span className="production-clip-name">{clipAssetName(clip.id)}</span>
                            {selected ? (
                              <span
                                className="production-clip-remove"
                                role="button"
                                title={t("drawer.removeClipTitle")}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onRemoveClip(clip.id);
                                }}
                              >
                                ×
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="production-drawer-body production-grade">
          {gradeImagePath || gradeVideoPath ? (
            <GradePanel
              key={targetKey(target)}
              imagePath={gradeImagePath}
              videoPath={gradeVideoPath}
              initialDoc={gradeDoc}
              onCommit={(commit) => onGradeCommit(commit.gradeDoc)}
            />
          ) : (
            <p className="production-grade-empty">{t("drawer.gradePlaceholder")}</p>
          )}
        </div>
      )}
    </div>
  );
}
