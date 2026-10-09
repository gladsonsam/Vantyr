import { lazy, Suspense, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/app/queryClient";

// Dev-only: `import.meta.env.DEV` is statically false in production builds, so the devtools chunk
// is dropped from the bundle entirely.
const QueryDevtools = import.meta.env.DEV
  ? lazy(() => import("@tanstack/react-query-devtools").then((m) => ({ default: m.ReactQueryDevtools })))
  : null;

/** Owns the app's TanStack Query cache for server state. */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      {children}
      {QueryDevtools ? (
        <Suspense fallback={null}>
          {/* Bottom-right: bottom-left covers the sidebar's account trigger. */}
          <QueryDevtools buttonPosition="bottom-right" />
        </Suspense>
      ) : null}
    </QueryClientProvider>
  );
}
