import type { QualityReport } from "./quality";

/** Exported artifact paths recorded for a finished workflow. */
export interface ExportedArtifacts {
  psd: string;
  preview: string;
  metadata: string;
}

/** End-to-end production workflow tracking, written alongside an export. */
export interface ProductionMetadata {
  workflow_id: string;
  source_psd: string;
  provider_profile: string;
  prompt: string;
  prompt_suffix: string;
  generated_files: string[];
  enhance_steps: string[];
  quality_report: QualityReport | null;
  exported: ExportedArtifacts;
}
