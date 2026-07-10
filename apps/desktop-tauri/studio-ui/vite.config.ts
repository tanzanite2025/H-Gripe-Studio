import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The single H-Gripe Desktop front end. Builds to the Tauri `frontendDist`
// (../dist); the output is gitignored and produced by the Tauri before* hooks.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@hgripe\/flow\/style\.css$/,
        replacement: fileURLToPath(new URL("../../../packages/hgripe-flow/src/style.css", import.meta.url)),
      },
      {
        find: /^@hgripe\/flow$/,
        replacement: fileURLToPath(new URL("../../../packages/hgripe-flow/src/index.ts", import.meta.url)),
      },
      // Vendored upstream (no npm @xyflow packages): see packages/hgripe-flow/src/upstream.
      {
        find: /^@xyflow\/react$/,
        replacement: fileURLToPath(
          new URL("../../../packages/hgripe-flow/src/upstream/react/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@xyflow\/system$/,
        replacement: fileURLToPath(
          new URL("../../../packages/hgripe-flow/src/upstream/system/index.ts", import.meta.url),
        ),
      },
      // The vendored source lives outside this app dir, so its bare imports
      // must resolve back into this app's node_modules.
      ...[
        "classcat",
        "zustand",
        "react",
        "react-dom",
        "d3-drag",
        "d3-selection",
        "d3-transition",
        "d3-zoom",
      ].map((dep) => ({
        find: new RegExp(`^${dep}(/.*)?$`),
        replacement: fileURLToPath(new URL(`node_modules/${dep}`, import.meta.url)) + "$1",
      })),
    ],
  },
  // Relative base so assets resolve correctly when served via tauri://localhost.
  base: "./",
  // Tauri's `devUrl` points here; a fixed port keeps the two in sync.
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "node",
  },
});
