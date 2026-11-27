import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { networkKeys } from "@/api/queries/network";
import { useNetworkRuntime } from "@/features/network/runtime/NetworkRuntimeSource";
import { keepPreviousWithinScope } from "@/features/network/runtime/useRuntimeQueries";
import type { EventsPage, EventsQuery, Availability } from "@/features/network/runtime/types";

/**
 * The household activity list, loaded a page at a time by following each page's `nextCursor`.
 * Changing any filter changes the key, so the list restarts from the newest row.
 */
export function useActivityEvents(query: Omit<EventsQuery, "cursor">) {
  const runtime = useNetworkRuntime();
  return useInfiniteQuery({
    // The runtime's scope (source kind + household) is part of the key: an old household's rows,
    // totals and cursors can never appear, or be continued, under another.
    queryKey: [...networkKeys.all, "runtime", runtime.scope, "events-list", query] as const,
    placeholderData: keepPreviousWithinScope<
      InfiniteData<Availability<EventsPage>, string | undefined>
    >(runtime.scope),
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
  const runtime = useNetworkRuntime();
  // Only the current scope's lists restart; other households' cached lists are untouched.
  return () =>
    void queryClient.resetQueries({
      queryKey: [...networkKeys.all, "runtime", runtime.scope, "events-list"],
    });
}
