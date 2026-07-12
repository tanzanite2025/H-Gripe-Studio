import { useEffect, useState, type PointerEvent } from "react";

import "./SubjectSelectionDialog.css";
import { SubjectSelectionAdjustPanel } from "./subjectSelectionDialog/SubjectSelectionAdjustPanel";
import { SubjectSelectionModelPromptPanel } from "./subjectSelectionDialog/SubjectSelectionModelPromptPanel";
import { SubjectSelectionToolPanel } from "./subjectSelectionDialog/SubjectSelectionToolPanel";
import { SubjectSelectionWorkspacePanel } from "./subjectSelectionDialog/SubjectSelectionWorkspacePanel";
import {
  createSubjectPromptRegionFromDrag,
  hasVisibleSubjectPromptRegion,
  pointerEventToSubjectPreviewPoint,
} from "./subjectSelectionDialog/subjectSelectionPreviewGeometry";
import type {
  SubjectPreviewDrawing,
  SubjectPromptRegion,
  SubjectPromptShape,
  SubjectResultManualRefinementBrushMode,
  SubjectResultManualRefinementStroke,
} from "./subjectSelectionDialog/subjectSelectionTypes";

interface SubjectSelectionDialogProps {
  onClose: () => void;
}

const SUBJECT_RESULT_REFINEMENT_BRUSH_MIN_SIZE = 6;
const SUBJECT_RESULT_REFINEMENT_BRUSH_MAX_SIZE = 96;
const SUBJECT_RESULT_REFINEMENT_BRUSH_SIZE_STEP = 4;

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

export function SubjectSelectionDialog({ onClose }: SubjectSelectionDialogProps) {
  const [activeShape, setActiveShape] = useState<SubjectPromptShape>("rect");
  const [promptRegion, setPromptRegion] = useState<SubjectPromptRegion | null>(null);
  const [lastCalculatedPromptRegion, setLastCalculatedPromptRegion] = useState<SubjectPromptRegion | null>(null);
  const [drawing, setDrawing] = useState<SubjectPreviewDrawing | null>(null);
  const [drawingRegion, setDrawingRegion] = useState<SubjectPromptRegion | null>(null);
  const [resultRegion, setResultRegion] = useState<SubjectPromptRegion | null>(null);
  const [activeManualRefinementBrushMode, setActiveManualRefinementBrushMode] =
    useState<SubjectResultManualRefinementBrushMode | null>(null);
  const [manualRefinementBrushSize, setManualRefinementBrushSize] = useState(24);
  const [manualRefinementStrokes, setManualRefinementStrokes] = useState<SubjectResultManualRefinementStroke[]>([]);
  const [activeManualRefinementPointerId, setActiveManualRefinementPointerId] = useState<number | null>(null);
  const [threshold, setThreshold] = useState(55);
  const [expand, setExpand] = useState(0);
  const [smooth, setSmooth] = useState(12);
  const [feather, setFeather] = useState(1);
  const [edgeRefine, setEdgeRefine] = useState(30);

  const chooseShape = (nextShape: SubjectPromptShape) => {
    setActiveShape(nextShape);
    setDrawing(null);
    setDrawingRegion(null);
  };

  const decreaseSubjectResultManualRefinementBrushSize = () => {
    setManualRefinementBrushSize((size) =>
      Math.max(SUBJECT_RESULT_REFINEMENT_BRUSH_MIN_SIZE, size - SUBJECT_RESULT_REFINEMENT_BRUSH_SIZE_STEP),
    );
  };

  const increaseSubjectResultManualRefinementBrushSize = () => {
    setManualRefinementBrushSize((size) =>
      Math.min(SUBJECT_RESULT_REFINEMENT_BRUSH_MAX_SIZE, size + SUBJECT_RESULT_REFINEMENT_BRUSH_SIZE_STEP),
    );
  };

  useEffect(() => {
    const handleSubjectResultManualRefinementBrushSizeShortcut = (e: KeyboardEvent) => {
      if (isEditableKeyboardTarget(e.target)) return;
      if (e.key === "[") {
        e.preventDefault();
        decreaseSubjectResultManualRefinementBrushSize();
      } else if (e.key === "]") {
        e.preventDefault();
        increaseSubjectResultManualRefinementBrushSize();
      }
    };
    window.addEventListener("keydown", handleSubjectResultManualRefinementBrushSizeShortcut);
    return () => window.removeEventListener("keydown", handleSubjectResultManualRefinementBrushSizeShortcut);
  }, []);

  const appendSubjectResultManualRefinementStrokeAtPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (!activeManualRefinementBrushMode || !resultRegion) return;
    const [x, y] = pointerEventToSubjectPreviewPoint(e);
    setManualRefinementStrokes((strokes) => [
      ...strokes,
      {
        id: `subject_result_refinement_${Date.now()}_${strokes.length}`,
        mode: activeManualRefinementBrushMode,
        x,
        y,
        radius: manualRefinementBrushSize / 2,
      },
    ]);
  };

  const startDrawingPromptRegion = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if (resultRegion && activeManualRefinementBrushMode) {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setActiveManualRefinementPointerId(e.pointerId);
      appendSubjectResultManualRefinementStrokeAtPointer(e);
      return;
    }
    if (e.target instanceof Element && e.target.closest(".subject-selection-prompt-shape")) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = pointerEventToSubjectPreviewPoint(e);
    setDrawing({ pointerId: e.pointerId, startX: x, startY: y });
    setDrawingRegion(createSubjectPromptRegionFromDrag(activeShape, x, y, x, y));
    setResultRegion(null);
    setLastCalculatedPromptRegion(null);
    setManualRefinementStrokes([]);
    setActiveManualRefinementBrushMode(null);
  };

  const updateDrawingPromptRegion = (e: PointerEvent<SVGSVGElement>) => {
    if (activeManualRefinementPointerId === e.pointerId && resultRegion && activeManualRefinementBrushMode) {
      e.preventDefault();
      e.stopPropagation();
      appendSubjectResultManualRefinementStrokeAtPointer(e);
      return;
    }
    if (!drawing || drawing.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = pointerEventToSubjectPreviewPoint(e);
    setDrawingRegion(createSubjectPromptRegionFromDrag(activeShape, drawing.startX, drawing.startY, x, y));
  };

  const finishDrawingPromptRegion = (e: PointerEvent<SVGSVGElement>) => {
    if (activeManualRefinementPointerId === e.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setActiveManualRefinementPointerId(null);
      return;
    }
    if (!drawing || drawing.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const [x, y] = pointerEventToSubjectPreviewPoint(e);
    const nextRegion = createSubjectPromptRegionFromDrag(activeShape, drawing.startX, drawing.startY, x, y);
    setPromptRegion(hasVisibleSubjectPromptRegion(nextRegion) ? nextRegion : null);
    setDrawing(null);
    setDrawingRegion(null);
  };

  const confirmPromptRegionAsSubjectResult = () => {
    if (!promptRegion) return;
    setLastCalculatedPromptRegion(promptRegion);
    setResultRegion(promptRegion);
    setPromptRegion(null);
    setManualRefinementStrokes([]);
  };

  const recalculateSubjectResult = () => {
    const region = promptRegion ?? lastCalculatedPromptRegion;
    if (!region) return;
    setLastCalculatedPromptRegion(region);
    setResultRegion(region);
    setPromptRegion(null);
    setManualRefinementStrokes([]);
  };

  return (
    <div className="subject-selection-backdrop" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <section className="subject-selection-dialog" role="dialog" aria-modal="true" aria-label="主体选择">
        <header className="subject-selection-head">
          <span className="subject-selection-title">主体选择</span>
          <button className="subject-selection-close" type="button" title="关闭" onClick={onClose}>
            x
          </button>
        </header>

        <div className="subject-selection-body">
          <SubjectSelectionWorkspacePanel
            promptRegion={promptRegion}
            drawingRegion={drawingRegion}
            resultRegion={resultRegion}
            manualRefinementStrokes={manualRefinementStrokes}
            activeManualRefinementBrushMode={activeManualRefinementBrushMode}
            onPointerDown={startDrawingPromptRegion}
            onPointerMove={updateDrawingPromptRegion}
            onPointerUp={finishDrawingPromptRegion}
          />
          <div className="subject-selection-side-column">
            <SubjectSelectionToolPanel activeShape={activeShape} onShapeChange={chooseShape} />
            <SubjectSelectionModelPromptPanel />
            <SubjectSelectionAdjustPanel
              threshold={threshold}
              expand={expand}
              smooth={smooth}
            feather={feather}
              edgeRefine={edgeRefine}
              canConfirm={Boolean(promptRegion)}
              canRecalculate={Boolean(promptRegion ?? lastCalculatedPromptRegion)}
              canUseManualRefinementBrush={Boolean(resultRegion)}
              activeManualRefinementBrushMode={activeManualRefinementBrushMode}
              manualRefinementBrushSize={manualRefinementBrushSize}
              onThresholdChange={setThreshold}
            onExpandChange={setExpand}
            onSmoothChange={setSmooth}
              onFeatherChange={setFeather}
              onEdgeRefineChange={setEdgeRefine}
              onManualRefinementBrushModeChange={setActiveManualRefinementBrushMode}
              onRecalculate={recalculateSubjectResult}
            onConfirm={confirmPromptRegionAsSubjectResult}
          />
          </div>
        </div>
      </section>
    </div>
  );
}
