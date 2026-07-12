// Dialog-local result refinement icons. These are not the main editor brush
// tools: they only select how manual circles should refine the subject result.
export function AddToSubjectResultBrushIcon() {
  return (
    <svg className="subject-selection-action-icon" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 4v10" />
      <path d="M4 9h10" />
    </svg>
  );
}

export function SubtractFromSubjectResultBrushIcon() {
  return (
    <svg className="subject-selection-action-icon" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M4 9h10" />
    </svg>
  );
}
