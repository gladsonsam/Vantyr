import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { api } from "@/api";
import type {
  DnsEventRow,
  DnsEventsRequest,
  DnsEventsResponse,
  DnsStatsRequest,
} from "@/api/types";
import { networkKeys } from "./network";

/** Filters for the paged list. Paging (`cursor`, `offset`) is owned by the hook, so it is not accepted. */
export type DnsEventsFilters = Omit<DnsEventsRequest, "cursor" | "offset">;

/** What the next page needs: the cursor plus the exact window the first page returned. */
export interface DnsEventsPageParam {
  cursor: string;
  from: string;
  to: string;
}

export const dnsEventsKeys = {
  root: (household: string) => [...networkKeys.all, household, "dns-events"] as const,
  list: (household: string, filters: DnsEventsFilters) =>
    [...dnsEventsKeys.root(household), "list", filters] as const,
  stats: (household: string, query: DnsStatsRequest) =>
    [...dnsEventsKeys.root(household), "stats", query] as const,
};

export const dnsEventsQueries = {
  list: (household: string, filters: DnsEventsFilters = {}) =>
    infiniteQueryOptions({
      queryKey: dnsEventsKeys.list(household, filters),
      initialPageParam: undefined as DnsEventsPageParam | undefined,
      queryFn: ({ pageParam }): Promise<DnsEventsResponse> =>
        api.dnsEvents(
          household,
          pageParam
            ? // Same fixed window as the first page, so a moving default "now" never changes the query.
              { ...filters, cursor: pageParam.cursor, from: pageParam.from, to: pageParam.to }
            : filters,
        ),
      getNextPageParam: (last): DnsEventsPageParam | undefined =>
        last.has_more && last.next_cursor
          ? { cursor: last.next_cursor, from: last.from, to: last.to }
          : undefined,
    }),
  stats: (household: string, query: DnsStatsRequest = {}) =>
    queryOptions({
      queryKey: dnsEventsKeys.stats(household, query),
      queryFn: () => api.dnsStats(household, query),
    }),
};

/**
 * DNS observations, newest first, loaded a page at a time by following `next_cursor` with the first
 * page's `from`/`to`. Changing a filter restarts the list. Requires `network_admin` or `network_events`.
 */
export function useDnsEvents(
  household: string,
  filters: DnsEventsFilters = {},
  opts?: { enabled?: boolean },
) {
  return useInfiniteQuery({
    ...dnsEventsQueries.list(household, filters),
    placeholderData: keepPreviousData,
    enabled: opts?.enabled ?? true,
  });
}

/** Statistics for one requested window. Requires `network_admin` or `network_events`. */
export function useDnsStats(
  household: string,
  query: DnsStatsRequest = {},
  opts?: { enabled?: boolean },
) {
  return useQuery({ ...dnsEventsQueries.stats(household, query), enabled: opts?.enabled ?? true });
}

/**
 * All rows of the loaded pages, deduplicated by `event_id` (live changes between pages can repeat a
 * row), keeping the first occurrence so order stays newest first.
 */
export function flattenDnsEventPages(
  pages: readonly DnsEventsResponse[] | undefined,
): DnsEventRow[] {
  const seen = new Set<string>();
  const out: DnsEventRow[] = [];
  for (const page of pages ?? []) {
    for (const row of page.rows) {
      if (seen.has(row.event_id)) continue;
      seen.add(row.event_id);
      out.push(row);
    }
  }
  return out;
}
