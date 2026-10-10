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
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
            return "react-vendor";
          }
          if (id.includes("node_modules/lucide-react")) {
            return "lucide";
          }
          // The terminal emulator is only needed once the Terminal tab mounts,
          // and it is by far the heaviest dependency.
          if (id.includes("node_modules/@xterm/")) {
            return "xterm";
          }
          if (id.includes("node_modules/react-router")) {
            return "router";
          }
        },
      },
    },
  },
  // In dev mode, proxy API and WS requests to the Rust server so
  // `npm run dev` works without CORS issues.
  server: {
    allowedHosts: ["dev1-5173.gladsonsam.com"],
    proxy: {
      // The server refuses plain HTTP unless it sees a TLS-terminating proxy.
      "/api": { target: "http://localhost:9000", headers: { "x-forwarded-proto": "https" } },
      "/ws": {
        target: "ws://localhost:9000",
        ws: true,
        changeOrigin: true,
        headers: { "x-forwarded-proto": "https" },
      },
    },
  },
});
