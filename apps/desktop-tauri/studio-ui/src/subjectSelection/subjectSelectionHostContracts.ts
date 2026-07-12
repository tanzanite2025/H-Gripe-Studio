export type SubjectSelectionHostKind = "image_editor" | "node_canvas" | "video_clip" | "color_grade";

export type SubjectSelectionBackfillCapability =
  | "image_editor_active_selection"
  | "node_canvas_mask_input"
  | "video_clip_frame_mask_seed"
  | "color_grade_mask";

export interface SubjectSelectionSourceReference {
  hostKind: SubjectSelectionHostKind;
  sourceId: string;
  sourceFingerprint: string;
  width: number;
  height: number;
}

export interface SubjectSelectionResult {
  source: SubjectSelectionSourceReference;
  maskWidth: number;
  maskHeight: number;
  maskDataRef: string;
  contourPaths: readonly string[];
  promptMetadata: Record<string, unknown>;
  refineParams: Record<string, unknown>;
  providerReport: Record<string, unknown>;
}

export interface SubjectSelectionBackfillTarget {
  hostKind: SubjectSelectionHostKind;
  targetId: string;
  label: string;
  sourceFingerprint: string;
  capabilities: readonly SubjectSelectionBackfillCapability[];
}

// Subject Selection behaves like a plug-in: it may discover host targets and
// return a neutral result, but it must not mutate image editor, node, video, or
// color-grade state directly. Each host owns its own explicit backfill adapter.
export interface SubjectSelectionBackfillAdapter {
  hostKind: SubjectSelectionHostKind;
  getSubjectSelectionBackfillTargets(): readonly SubjectSelectionBackfillTarget[];
  backfillSubjectSelectionResultToHostTarget(
    result: SubjectSelectionResult,
    target: SubjectSelectionBackfillTarget,
  ): Promise<void>;
}
