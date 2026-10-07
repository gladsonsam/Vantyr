import { createElement, type ReactNode } from "react";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryDefaults } from "@/app/queryClient";

// Deliver query updates on a microtask instead of a 0 ms timer, so `await act(async () => …)`
// sees settled queries (and fake timers don't hold them back).
notifyManager.setScheduler(queueMicrotask);

/** A fresh cache with the app's defaults, minus retries so failures surface immediately. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...queryDefaults.queries, retry: false, gcTime: Infinity },
      mutations: { ...queryDefaults.mutations, retry: false },
    },
  });
}

/** Wrap a test tree in a QueryClientProvider (a fresh client unless one is passed). */
export function withQueryClient(node: ReactNode, client: QueryClient = createTestQueryClient()): ReactNode {
  return createElement(QueryClientProvider, { client }, node);
}
