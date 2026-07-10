import { port, type NodeSpec } from "./types";

export const OUTPUT_NODE_SPECS = {
  save: {
    kind: "save",
    family: "export",
    executor: "graph",
    title: "Export",
    description:
      "Sink node: collects the resulting image path (and optional PSD template) for export.",
    category: "output",
    inputs: [
      port("image", "image", "image"),
      port("template", "template", "any"),
    ],
    outputs: [],
    params: [
      { key: "filename", label: "File name", control: "text", defaultValue: "output.png", inline: true },
    ],
  },
  psdExport: {
    kind: "psdExport",
    family: "psd",
    executor: "local",
    title: "PSD Export",
    description:
      "Write the generated image into a PSD template's placeholder (true smart-object replacement when possible) and export final.psd + preview.png + metadata.json. Accepts an optional refined mask (applied as the image's alpha) and a production metadata object merged into the exported metadata. A connected layered asset (Smart Layer Split) stands in for the image via its composite preview, and its layer manifest (names, bbox, alpha refs) is recorded in the exported metadata.",
    category: "output",
    inputs: [
      port("image", "image", "image"),
      port("layered_asset", "layered asset", "any"),
      port("template", "template", "any"),
      port("mask", "mask", "image"),
      port("metadata", "metadata", "any"),
    ],
    outputs: [],
    params: [
      { key: "filename", label: "File name", control: "text", defaultValue: "final", inline: true },
      {
        key: "output_dir",
        label: "Output dir",
        control: "path",
        defaultValue: "",
        hint: "leave empty to use the configured output directory",
      },
      {
        key: "placeholder",
        label: "Placeholder layer",
        control: "text",
        defaultValue: "",
        hint: "template layer name to replace (empty = whole canvas)",
        inline: true,
      },
      {
        key: "fit_mode",
        label: "Fit",
        control: "select",
        options: ["contain", "cover", "stretch"],
        defaultValue: "contain",
        inline: true,
      },
      {
        key: "smart_object_mode",
        label: "Smart object",
        control: "select",
        options: ["disable", "replace_content"],
        defaultValue: "replace_content",
        hint: "replace_content rewrites the smart object (stays editable in Photoshop)",
        inline: true,
      },
    ],
  },
} satisfies Record<string, NodeSpec>;
