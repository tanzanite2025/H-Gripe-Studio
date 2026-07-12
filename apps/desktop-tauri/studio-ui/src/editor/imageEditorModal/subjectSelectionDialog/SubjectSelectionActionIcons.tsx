// These icons are intentionally named by the subject-selection action they
// trigger. Keep them separate from generic editor icons so future debugging can
// see that refresh means "recalculate subject result", not browser refresh,
// viewport refresh, or editor redraw.
export function RecalculateSubjectSelectionResultIcon() {
  return (
    <svg className="subject-selection-action-icon" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M14.5 8.2A5.7 5.7 0 0 0 4.6 4.5L3.2 5.9" />
      <path d="M3.2 2.6v3.3h3.3" />
      <path d="M3.5 9.8a5.7 5.7 0 0 0 9.9 3.7l1.4-1.4" />
      <path d="M14.8 15.4v-3.3h-3.3" />
    </svg>
  );
}

// Confirms the prompt region as the input for subject calculation. This is not
// a generic save/apply icon; it starts the dialog-local subject-result flow.
export function ConfirmPromptRegionForSubjectCalculationIcon() {
  return (
    <svg className="subject-selection-action-icon" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3.2 9.4 7.1 13 14.8 5" />
    </svg>
  );
}
