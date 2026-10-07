import { QueryClient, type DefaultOptions } from "@tanstack/react-query";
import { isApiError } from "@/api/client";

/** A 4xx is the server's final answer (auth, permissions, validation); retrying only repeats it. */
function isClientError(error: unknown): boolean {
  return isApiError(error) && error.status >= 400 && error.status < 500;
}

/**
 * Dashboard query defaults. Screens load on mount and when their key changes, and refetch when a
 * mutation invalidates them or on their own `refetchInterval` — never on window focus or network
 * reconnect, which would fan out heavy history/analytics requests across every mounted screen.
 * A failed request is retried once unless the server rejected it with a 4xx.
 */
export const queryDefaults: DefaultOptions = {
  queries: {
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (failureCount, error) => failureCount < 1 && !isClientError(error),
  },
  mutations: {
    retry: false,
  },
};

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: queryDefaults });
}
