import {
  ConfirmPromptRegionForSubjectCalculationIcon,
  RecalculateSubjectSelectionResultIcon,
} from "./SubjectSelectionActionIcons";
import {
  AddToSubjectResultBrushIcon,
  SubtractFromSubjectResultBrushIcon,
} from "./SubjectSelectionResultRefinementIcons";
import type { SubjectResultManualRefinementBrushMode } from "./subjectSelectionTypes";

interface SubjectSelectionAdjustPanelProps {
  threshold: number;
  expand: number;
  smooth: number;
  feather: number;
  edgeRefine: number;
  canConfirm: boolean;
  canRecalculate: boolean;
  canUseManualRefinementBrush: boolean;
  activeManualRefinementBrushMode: SubjectResultManualRefinementBrushMode | null;
  manualRefinementBrushSize: number;
  onThresholdChange: (value: number) => void;
  onExpandChange: (value: number) => void;
  onSmoothChange: (value: number) => void;
  onFeatherChange: (value: number) => void;
  onEdgeRefineChange: (value: number) => void;
  onManualRefinementBrushModeChange: (mode: SubjectResultManualRefinementBrushMode) => void;
  onRecalculate: () => void;
  onConfirm: () => void;
}

export function SubjectSelectionAdjustPanel({
  threshold,
  expand,
  smooth,
  feather,
  edgeRefine,
  canConfirm,
  canRecalculate,
  canUseManualRefinementBrush,
  activeManualRefinementBrushMode,
  manualRefinementBrushSize,
  onThresholdChange,
  onExpandChange,
  onSmoothChange,
  onFeatherChange,
  onEdgeRefineChange,
  onManualRefinementBrushModeChange,
  onRecalculate,
  onConfirm,
}: SubjectSelectionAdjustPanelProps) {
  return (
    <section className="subject-selection-grid-panel subject-selection-adjust-panel" aria-label="结果蚂蚁线微调">
      <div className="subject-selection-section">
        <div className="subject-selection-section-title-row">
          <span className="subject-selection-label">结果修正画笔</span>
          <span className="subject-selection-brush-size-label">{manualRefinementBrushSize}px</span>
        </div>
        <div className="subject-selection-result-brush-tools" role="group" aria-label="结果修正画笔">
          <button
            type="button"
            disabled={!canUseManualRefinementBrush}
            className={activeManualRefinementBrushMode === "add_to_subject_result" ? "active" : ""}
            aria-pressed={activeManualRefinementBrushMode === "add_to_subject_result"}
            aria-label="加到主体结果"
            title="加到主体结果"
            onClick={() => onManualRefinementBrushModeChange("add_to_subject_result")}
          >
            <AddToSubjectResultBrushIcon />
          </button>
          <button
            type="button"
            disabled={!canUseManualRefinementBrush}
            className={activeManualRefinementBrushMode === "subtract_from_subject_result" ? "active" : ""}
            aria-pressed={activeManualRefinementBrushMode === "subtract_from_subject_result"}
            aria-label="从主体结果减去"
            title="从主体结果减去"
            onClick={() => onManualRefinementBrushModeChange("subtract_from_subject_result")}
          >
            <SubtractFromSubjectResultBrushIcon />
          </button>
        </div>
      </div>

      <div className="subject-selection-section">
        <span className="subject-selection-label">结果蚂蚁线微调</span>
        <label className="subject-selection-field">
          <span>置信度</span>
          <input type="range" min={0} max={100} value={threshold} onChange={(e) => onThresholdChange(Number(e.target.value))} />
          <output>{threshold}</output>
        </label>
        <label className="subject-selection-field">
          <span>扩张</span>
          <input type="range" min={-32} max={32} value={expand} onChange={(e) => onExpandChange(Number(e.target.value))} />
          <output>{expand}</output>
        </label>
        <label className="subject-selection-field">
          <span>平滑</span>
          <input type="range" min={0} max={64} value={smooth} onChange={(e) => onSmoothChange(Number(e.target.value))} />
          <output>{smooth}</output>
        </label>
        <label className="subject-selection-field">
          <span>羽化</span>
          <input type="range" min={0} max={32} value={feather} onChange={(e) => onFeatherChange(Number(e.target.value))} />
          <output>{feather}</output>
        </label>
        <label className="subject-selection-field">
          <span>边缘</span>
          <input type="range" min={0} max={100} value={edgeRefine} onChange={(e) => onEdgeRefineChange(Number(e.target.value))} />
          <output>{edgeRefine}</output>
        </label>
      </div>

      <div className="subject-selection-section">
        <label className="subject-selection-field subject-selection-engine">
          <span>计算</span>
          <select value="internal" disabled title="模型接入稍后独立实现">
            <option value="internal">内部</option>
          </select>
        </label>
      </div>

      <footer className="subject-selection-actions">
        <button
          type="button"
          disabled={!canRecalculate}
          aria-label="重新计算主体结果"
          title="重新计算主体结果"
          onClick={onRecalculate}
        >
          <RecalculateSubjectSelectionResultIcon />
        </button>
        <button
          type="button"
          disabled={!canConfirm}
          aria-label="确认提示区域并计算主体结果"
          title="确认提示区域并计算主体结果"
          onClick={onConfirm}
        >
          <ConfirmPromptRegionForSubjectCalculationIcon />
        </button>
      </footer>
    </section>
  );
}
