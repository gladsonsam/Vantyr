import { lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { AgentsProvider } from "@/app/providers/AgentsProvider";
import { NotificationsProvider } from "@/app/providers/NotificationsProvider";
import { SessionProvider } from "@/app/providers/SessionProvider";
import { ThemeProvider } from "@/app/providers/ThemeProvider";
import { useSession } from "@/app/providers/useSession";
import { AppRoutes } from "@/app/router";

const LoginPage = lazy(() => import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })));

/** Branded full-screen loader for auth/route-chunk loads — matches the index.html
 *  boot splash so the hand-off is seamless (no black flash). */
function LoadShell({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-[18px] bg-background font-sans text-muted-foreground">
      <div className="size-[42px] animate-spin rounded-full border-[3px] border-muted border-t-primary" />
      <div className="text-[13px] font-medium tracking-[0.02em]">{label}</div>
    </div>
  );
}

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
