import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  // The root tsconfig extends p0code's, which only exists inside the workspace.
  tsconfig: fileURLToPath(new URL("tsconfig.json", import.meta.url)),
  resolve: {
    alias: {
      "@t3tools/plugin-api": fileURLToPath(new URL("stubs/plugin-api.ts", import.meta.url)),
      "vite-plus/test": fileURLToPath(new URL("stubs/vite-plus-test.ts", import.meta.url)),
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
