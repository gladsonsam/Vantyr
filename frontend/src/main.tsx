import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "@/app/Root";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { registerServiceWorker } from "@/lib/pwa";
// App base styles (body background/type, keyframes, scrollbars).
import "@/styles/index.css";
// Tailwind v4 + shadcn/ui (Base UI) tokens for the redesigned dashboard.
import "@/styles/ui.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="app-root">
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);

// Register the PWA service worker (installable app + Web Push). No-ops where
// service workers aren't available (e.g. insecure non-localhost origins).
registerServiceWorker();
