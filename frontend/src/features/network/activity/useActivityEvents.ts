import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { networkKeys } from "@/api/queries/network";
import { useNetworkRuntime } from "@/features/network/runtime/NetworkRuntimeSource";
import type { EventsQuery } from "@/features/network/runtime/types";

/**
 * The household activity list, loaded a page at a time by following each page's `nextCursor`.
 * Changing any filter changes the key, so the list restarts from the newest row.
 */
export function useActivityEvents(query: Omit<EventsQuery, "cursor" | "offset">) {
  const runtime = useNetworkRuntime();
  return useInfiniteQuery({
    queryKey: [...networkKeys.all, "runtime", "events-list", query] as const,
    placeholderData: keepPreviousData,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => runtime.events({ ...query, cursor: pageParam }),
    getNextPageParam: (last) =>
      last.state === "ready" && last.data.hasMore && last.data.nextCursor
        ? last.data.nextCursor
        : undefined,
  });
}

/** Starts the list over from the newest row, with a fresh window. Used when "Load more" can no longer continue. */
export function useResetActivityEvents() {
  const queryClient = useQueryClient();
  return () =>
    void queryClient.resetQueries({ queryKey: [...networkKeys.all, "runtime", "events-list"] });
}
