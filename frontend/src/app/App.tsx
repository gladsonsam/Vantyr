import { lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { AgentsProvider } from "@/app/providers/AgentsProvider";
import { NotificationsProvider } from "@/app/providers/NotificationsProvider";
import { SessionProvider } from "@/app/providers/SessionProvider";
import { ThemeProvider } from "@/app/providers/ThemeProvider";
import { useSession } from "@/app/providers/useSession";
import { AppRoutes } from "./router";
import { LoadShell } from "@/app/shell/LoadShell";

const LoginPage = lazy(() => import("@/features/auth/LoginPage").then((m) => ({ default: m.LoginPage })));

export function App() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <NotificationsProvider>
          <AgentsProvider>
            <Dashboard />
          </AgentsProvider>
        </NotificationsProvider>
      </SessionProvider>
    </ThemeProvider>
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
