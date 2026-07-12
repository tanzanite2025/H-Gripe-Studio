export function SubjectSelectionModelPromptPanel() {
  return (
    <section className="subject-selection-grid-panel subject-selection-model-prompt-panel" aria-label="模型提示词">
      <span className="subject-selection-label">模型提示词</span>
      <textarea className="subject-selection-model-prompt" value="" readOnly aria-label="模型提示词内容" />
    </section>
  );
}
