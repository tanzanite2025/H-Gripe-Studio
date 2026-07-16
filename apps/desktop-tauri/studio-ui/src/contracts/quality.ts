/** A single detected quality issue. */
export interface QualityIssue {
  type: string;
  confidence: number;
  bbox: [number, number, number, number];
  suggested_action: string;
}

/** Aggregate quality findings for a candidate image. */
export interface QualityReport {
  status: string;
  issues: QualityIssue[];
}

/** Per-region outcome of a Detail Repaint run. */
export interface RepaintRegionResult {
  index: number;
  type?: string | null;
  bbox?: [number, number, number, number] | null;
  status: string;
  feather_px?: number | null;
  blend?: string | null;
}

/** Outcome of the Detail Repaint node. */
export interface RepaintReport {
  status: string;
  regions: RepaintRegionResult[];
  repainted_count: number;
  requested_count: number;
  image_size: [number, number];
  blend?: string;
}
