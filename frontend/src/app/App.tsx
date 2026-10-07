import { Fragment, lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { AgentsProvider } from "@/app/providers/AgentsProvider";
import { NotificationsProvider } from "@/app/providers/NotificationsProvider";
import { QueryProvider } from "@/app/providers/QueryProvider";
import { SessionProvider } from "@/app/providers/SessionProvider";
import { ThemeProvider } from "@/app/providers/ThemeProvider";
import { useSession } from "@/app/providers/useSession";
import { AppRoutes } from "./router";
import { LoadShell } from "@/app/shell/LoadShell";

/**
 * The one place that knows about demo mode: demo builds replace the REST client with a fake
 * server and wrap the app in the demo's adapters (simulated desktop, fleet feed, terminal,
 * clipboard, recall evidence). The demo is loaded on demand, so it is not part of real builds.
 */
const Environment = import.meta.env.VITE_VANTYR_DEMO_MODE === "true"
  ? lazy(() => import("@/demo/loadDemoEnvironment").then((demo) => demo.loadDemoEnvironment()))
  : Fragment;

const LoginPage = lazy(() => import("@/features/auth/LoginPage").then((m) => ({ default: m.LoginPage })));

export function App() {
  return (
    <Suspense fallback={null}>
      <Environment>
        <ThemeProvider>
          <QueryProvider>
            <SessionProvider>
              <NotificationsProvider>
                <AgentsProvider>
                  <Dashboard />
                </AgentsProvider>
              </NotificationsProvider>
            </SessionProvider>
          </QueryProvider>
        </ThemeProvider>
      </Environment>
    </Suspense>
  );
}

/** Auth gate: boot loader, then the login page or the signed-in routes. */
function Dashboard() {
  const { authenticated, completeLogin } = useSession();
  const location = useLocation();

  if (authenticated === null) {
    return <LoadShell />;
  }

  if (!authenticated) {
    return (
      <Suspense fallback={<LoadShell label="Loading sign-in…" />}>
        <LoginPage onLoginSuccess={completeLogin} />
      </Suspense>
    );
  }

  return (
    <ErrorBoundary resetKey={location.pathname} label="route">
      <Suspense fallback={<LoadShell label="Loading page…" />}>
        <AppRoutes />
      </Suspense>
    </ErrorBoundary>
  );
}
