/** A subject detected by a segmentation model. */
export interface DetectedSubject {
  label: string;
  confidence: number;
  bbox: [number, number, number, number];
}

/** Provenance and operations recorded for a matte run. */
export interface MatteReport {
  mode: string;
  provider: string;
  source_mode: string;
  exif_transposed: boolean;
  max_decode_pixels: number;
  image_size: [number, number];
  mask_coverage: number;
  detected_subjects: DetectedSubject[];
  operations: { type: string; [key: string]: unknown }[];
  triplet: { mask: boolean; alpha_image: boolean; cutout_image: boolean };
  processing_time_ms: number;
}

/** Result of a Subject Mask run. */
export interface SubjectMaskResult {
  mask_path: string;
  alpha_image_path: string;
  cutout_image_path: string;
  edit_paths_path: string;
  matte_report: MatteReport;
}
