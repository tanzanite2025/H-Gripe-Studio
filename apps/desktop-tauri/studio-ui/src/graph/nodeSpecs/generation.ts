import { port, type NodeSpec } from "./types";

export const GENERATION_NODE_SPECS = {
  generate: {
    kind: "generate",
    family: "api",
    executor: "api",
    title: "Generate",
    description:
      "Run an image generation operation through the H-Gripe broker.",
    category: "generate",
    inputs: [
      port("prompt", "prompt", "text"),
      port("reference", "reference", "image"),
      port("seed", "seed", "number"),
    ],
    outputs: [port("image", "image", "image")],
    params: [
      {
        key: "api_profile_ref",
        label: "API profile",
        control: "text",
        defaultValue: "",
        hint: "managed backend ref from the Models / APIs manager (set by the backend selector)",
        advanced: true,
      },
      {
        key: "provider",
        label: "Provider",
        control: "text",
        defaultValue: "mock",
        advanced: true,
      },
      {
        key: "operation",
        label: "Operation",
        control: "select",
        options: ["image.generate", "image.edit", "echo"],
        defaultValue: "image.generate",
        inline: true,
      },
      { key: "model", label: "Model", control: "text", defaultValue: "", advanced: true },
      { key: "size", label: "Size", control: "text", defaultValue: "1024x1024" },
      {
        key: "steps",
        label: "Steps",
        control: "slider",
        defaultValue: 20,
        min: 1,
        max: 50,
        step: 1,
        inline: true,
      },
      {
        key: "seed",
        label: "Seed",
        control: "number",
        defaultValue: 0,
        hint: "overridden by a connected seed input",
      },
      {
        key: "credentials_ref",
        label: "Credentials",
        control: "text",
        defaultValue: "",
        hint: "set automatically when you pick a profile",
        advanced: true,
      },
    ],
  },
} satisfies Record<string, NodeSpec>;
