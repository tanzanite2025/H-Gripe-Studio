// Central keyboard-shortcut module. `core.ts` is the scope-stack system;
// each scope's binding table lives under `scopes/` (image-editor today, node
// canvas / clip timeline later). Consumers import from this barrel.

export * from "./core";
