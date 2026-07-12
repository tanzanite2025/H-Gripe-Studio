import { ToolIcon } from "../toolIcons";
import type { SubjectPromptShape } from "./subjectSelectionTypes";

interface SubjectSelectionToolPanelProps {
  activeShape: SubjectPromptShape;
  onShapeChange: (shape: SubjectPromptShape) => void;
}

export function SubjectSelectionToolPanel({ activeShape, onShapeChange }: SubjectSelectionToolPanelProps) {
  return (
    <section className="subject-selection-grid-panel subject-selection-tool-panel" aria-label="提示区域工具">
      <span className="subject-selection-label">提示区域工具</span>
      <div className="subject-selection-tool-grid" role="group" aria-label="提示区域形状">
        <button
          type="button"
          className={activeShape === "rect" ? "active" : ""}
          aria-pressed={activeShape === "rect"}
          aria-label="矩形"
          title="矩形"
          onClick={() => onShapeChange("rect")}
        >
          <ToolIcon id="rect" />
        </button>
        <button
          type="button"
          className={activeShape === "ellipse" ? "active" : ""}
          aria-pressed={activeShape === "ellipse"}
          aria-label="圆形"
          title="圆形"
          onClick={() => onShapeChange("ellipse")}
        >
          <ToolIcon id="ellipse" />
        </button>
      </div>
    </section>
  );
}
