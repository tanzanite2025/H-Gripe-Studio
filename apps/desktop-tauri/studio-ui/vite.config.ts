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
      {
        find: /^@xyflow\/react\/dist\/style\.css$/,
        replacement: fileURLToPath(new URL("node_modules/@xyflow/react/dist/style.css", import.meta.url)),
      },
      {
        find: /^@xyflow\/react$/,
        replacement: fileURLToPath(new URL("node_modules/@xyflow/react/dist/esm/index.js", import.meta.url)),
      },
    ],
  },
  // Relative base so assets resolve correctly when served via tauri://localhost.
  base: "./",
  // Tauri's `devUrl` points here; a fixed port keeps the two in sync.
  server: {
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
