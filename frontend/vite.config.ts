import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// `VANTYR_API_TARGET` points the dev proxy at another server, e.g. the live one with
// `npm run dev:live` (see .env.live). Defaults to a local server on port 9000.
export default defineConfig(({ mode }) => {
  const apiTarget = loadEnv(mode, process.cwd(), "").VANTYR_API_TARGET || "http://localhost:9000";

  return {
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
        "/api": { target: apiTarget, changeOrigin: true, headers: { "x-forwarded-proto": "https" } },
        "/ws": {
          target: apiTarget.replace(/^http/, "ws"),
          ws: true,
          changeOrigin: true,
          headers: { "x-forwarded-proto": "https" },
        },
      },
    },
  };
});
