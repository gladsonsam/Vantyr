import { get } from "@/api/client";
import { buildDnsEventsQuery, buildDnsStatsQuery } from "@/api/dnsEventsValidation";
import type {
  DnsEventsRequest,
  DnsEventsResponse,
  DnsStatsRequest,
  DnsStatsResponse,
} from "@/api/types";

const base = (household: string) => `/network/households/${household}/dns`;
const withQuery = (path: string, query: string) => (query ? `${path}?${query}` : path);

/**
 * DNS observation reads (`network_admin` or `network_events`; GET, so no CSRF, cookie session only).
 * Invalid inputs throw `DnsEventsParamError` before any request. Server errors are the usual
 * `ApiError` carrying `{ "error": message }`: 400 unknown/invalid parameter, 401 session, 403 no grant.
 */
export const dnsEventsEndpoints = {
  /** Direct envelope, newest first. Follow `next_cursor` with the first page's `from`/`to`. */
  dnsEvents: (household: string, query: DnsEventsRequest = {}): Promise<DnsEventsResponse> =>
    get(withQuery(`${base(household)}/events`, buildDnsEventsQuery(query))),
  /** Direct envelope for one requested window, household-wide or for one device. */
  dnsStats: (household: string, query: DnsStatsRequest = {}): Promise<DnsStatsResponse> =>
    get(withQuery(`${base(household)}/stats`, buildDnsStatsQuery(query))),
};
