import { Component, type ErrorInfo, type ReactNode } from "react";

interface SubjectSelectionDialogFailureBoundaryProps {
  children: ReactNode;
  onClose: () => void;
}

interface SubjectSelectionDialogFailureBoundaryState {
  error: Error | null;
}

// Subject Selection is a plug-in-like flow inside host surfaces. This boundary
// keeps dialog render/runtime failures inside the dialog instead of letting
// them unmount or corrupt the image editor, node surface, or video surface.
export class SubjectSelectionDialogFailureBoundary extends Component<
  SubjectSelectionDialogFailureBoundaryProps,
  SubjectSelectionDialogFailureBoundaryState
> {
  state: SubjectSelectionDialogFailureBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): SubjectSelectionDialogFailureBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Subject selection dialog failed inside its isolated boundary", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="subject-selection-backdrop" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
        <section className="subject-selection-dialog subject-selection-failure-dialog" role="dialog" aria-modal="true" aria-label="主体选择出错">
          <header className="subject-selection-head">
            <span className="subject-selection-title">主体选择出错</span>
            <button className="subject-selection-close" type="button" title="关闭" onClick={this.props.onClose}>
              x
            </button>
          </header>
          <div className="subject-selection-failure-body">
            <span>主体选择内部出错，编辑器状态未更改。</span>
          </div>
        </section>
      </div>
    );
  }
}
