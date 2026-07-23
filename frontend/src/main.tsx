import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { registerServiceWorker } from "./lib/pwa";
// Reference design tokens (Satoshi/Bricolage fonts + full --gr/--tx/--card palette).
// Imported after App so its :root tokens win over the partial console-primitives set.
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="app-root">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);

// Register the PWA service worker (installable app + Web Push). No-ops where
// service workers aren't available (e.g. insecure non-localhost origins).
registerServiceWorker();
