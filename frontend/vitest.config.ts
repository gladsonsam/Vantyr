import { defineConfig } from "vitest/config";
import path from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@tests": path.resolve(import.meta.dirname, "./tests"),
    },
  },
  test: {
    environment: "jsdom",
    // Bound jsdom processes on high-core development hosts and CI runners.
    maxWorkers: 4,
    globals: true,
    css: { include: [/recall\.css/] },
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
  },
});
