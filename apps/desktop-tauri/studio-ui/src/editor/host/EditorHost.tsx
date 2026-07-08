import { Suspense, lazy } from "react";
import type { MaskDocument } from "../../types/production";
import type { EditState } from "../maskEdit";
import type { ImageDocument } from "../imageDocument";
import type { CropCommit } from "../CropEditModal";
import type { GradeCommit } from "../GradePanel";

// Editor Host: the application-level surface for the heavyweight editors
// (mask / crop / grade / unified media edit). Editors here are software
// features, not canvas features: a request carries only the edit target
// (an image path + display title) and initial edit data, and commits hand a
// result back to whoever opened the editor — the host knows nothing about
// nodes, the graph, or React Flow. The canvas side owns the adapters that
// derive a request from a node and fold a result back into params/new nodes.
// Important boundary: `nodeId` is opening/commit context only. Software-level
// editors display their concrete asset path; node-output viewport targets
// belong to preview gates, not to the editor's main canvas.
//
// Editors are code-split: nothing loads until a request opens one.

const MaskEditModal = lazy(() =>
  import("../MaskEditModal").then((m) => ({ default: m.MaskEditModal })),
);
const CropEditModal = lazy(() =>
  import("../CropEditModal").then((m) => ({ default: m.CropEditModal })),
);
const GradeEditModal = lazy(() =>
  import("../GradeEditModal").then((m) => ({ default: m.GradeEditModal })),
);
const MediaEditModal = lazy(() =>
  import("../MediaEditModal").then((m) => ({ default: m.MediaEditModal })),
);

/** What an editor edits: an asset/output reference, never node state. */
export interface EditorTarget {
  /** Backing image path (best-effort underlay); may be missing in preview. */
  imagePath: string | null;
  /** Backing video path, for grade targets that grade a video frame. */
  videoPath?: string | null;
  /** Display title for the editor chrome. */
  title: string;
  /** Opening context for graph adapters. Editors must not use this as their
   * display source; they render `imagePath` and commit back through callbacks. */
  nodeId?: string | null;
}

/** One open-document tab in the unified image editor's top strip (PS-style). */
export interface EditorTab {
  /** Image-source node id backing the tab. */
  id: string;
  /** Tab label (the image's filename). */
  label: string;
  active: boolean;
}

/** A request to open one editor over a target, with its commit sink. */
export type EditorRequest =
  | {
      editor: "mask";
      target: EditorTarget;
      initial: unknown;
      wandTolerance: number;
      onCommit: (edits: MaskDocument, state: EditState) => void;
    }
  | {
      editor: "crop";
      target: EditorTarget;
      initialMode: "manual" | "auto_subject";
      initialBox: [number, number, number, number] | null;
      initialAspect: string;
      initialMargin: number;
      onCommit: (commit: CropCommit) => void;
    }
  | {
      editor: "grade";
      target: EditorTarget;
      initialDoc: string | null;
      onCommit: (commit: GradeCommit) => void;
    }
  | {
      editor: "media";
      target: EditorTarget;
      /** "Open image" entry: lands the picked file on a new image card / tab. */
      onPickFile?: () => void;
      /** Open-document tabs (one per image card); clicking switches targets. */
      tabs?: EditorTab[];
      onSelectTab?: (id: string) => void;
      /** In-progress edit document restored when the tab re-activates. */
      initial?: ImageDocument | null;
      /** Draft sink: called on every edit so tab switches keep the document. */
      onDocChange?: (doc: ImageDocument) => void;
      onCommitMask: (edits: ImageDocument) => void;
      onCommitCrop: (commit: CropCommit) => void;
    };

interface EditorHostProps {
  request: EditorRequest | null;
  onClose: () => void;
}

export function EditorHost({ request, onClose }: EditorHostProps) {
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      {request.editor === "mask" && (
        <MaskEditModal
          title={request.target.title}
          imagePath={request.target.imagePath}
          nodeId={request.target.nodeId}
          initial={request.initial}
          wandTolerance={request.wandTolerance}
          onCommit={request.onCommit}
          onClose={onClose}
        />
      )}
      {request.editor === "crop" && (
        <CropEditModal
          title={request.target.title}
          imagePath={request.target.imagePath}
          nodeId={request.target.nodeId}
          initialMode={request.initialMode}
          initialBox={request.initialBox}
          initialAspect={request.initialAspect}
          initialMargin={request.initialMargin}
          onCommit={request.onCommit}
          onClose={onClose}
        />
      )}
      {request.editor === "grade" && (
        <GradeEditModal
          title={request.target.title}
          imagePath={request.target.imagePath}
          videoPath={request.target.videoPath}
          nodeId={request.target.nodeId}
          initialDoc={request.initialDoc}
          onCommit={request.onCommit}
          onClose={onClose}
        />
      )}
      {request.editor === "media" && (
        <MediaEditModal
          key={request.target.nodeId ?? "blank"}
          title={request.target.title}
          imagePath={request.target.imagePath}
          nodeId={request.target.nodeId}
          onPickFile={request.onPickFile}
          tabs={request.tabs}
          onSelectTab={request.onSelectTab}
          initial={request.initial}
          onDocChange={request.onDocChange}
          onCommitMask={request.onCommitMask}
          onCommitCrop={request.onCommitCrop}
          onClose={onClose}
        />
      )}
    </Suspense>
  );
}
