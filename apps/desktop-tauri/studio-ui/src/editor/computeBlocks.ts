/** Capability ids used by Studio Action dry-run plans. */
export type ComputeCapabilityId =
  | "mask.subject.salient"
  | "matte.alpha.refine"
  | "selection.from_colour"
  | "selection.from_path"
  | "image.inpaint";

/** Resource/cost classification shown before an action commits. */
export type ComputeCostClass = "free" | "local_compute" | "api_paid";
