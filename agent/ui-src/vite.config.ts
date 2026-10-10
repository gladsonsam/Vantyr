import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    cssMinify: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
