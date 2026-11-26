import { lazy, Suspense } from "react";
import { BrowserRouter } from "react-router-dom";
import { App } from "@/app/App";

/**
 * The hosted demo build is a marketing site with the interactive dashboard under /demo.
 * Real builds are just the dashboard at /.
 */
const DEMO_BASE = "/demo";
const isDemoBuild = import.meta.env.VITE_VANTYR_DEMO_MODE === "true";

// Loaded on demand so the landing page's effects never ship in the dashboard bundle.
const LandingPage = lazy(() =>
  import("@/landing/LandingPage").then((m) => ({ default: m.LandingPage })),
);

function onDemoPath() {
  const { pathname } = window.location;
  return pathname === DEMO_BASE || pathname.startsWith(`${DEMO_BASE}/`);
}

export function Root() {
  if (isDemoBuild && !onDemoPath()) {
    return (
      <Suspense fallback={null}>
        <LandingPage />
      </Suspense>
    );
  }
  return (
    <BrowserRouter basename={isDemoBuild ? DEMO_BASE : undefined}>
      <App />
    </BrowserRouter>
  );
}
