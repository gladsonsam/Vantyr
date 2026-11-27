import { api, isDnsEventsParamError } from "@/api";
import type {
  DnsEventRow,
  DnsEventsRequest,
  DnsEventsResponse,
  DnsStatsRequest,
  DnsStatsResponse,
} from "@/api/types";
import { UNLABELLED_DEVICE, UNRECOGNISED_DEVICE } from "@/features/network/activity/evidenceLib";
import { unavailableRuntime, type NetworkRuntimeSource } from "./NetworkRuntimeSource";
import type {
  Availability,
  DnsStats,
  DnsStatsQuery,
  EventsPage,
  EventsQuery,
  EventSource,
  NetworkEvent,
} from "./types";

/** The most rows one request may ask for (the server rejects more). */
const MAX_LIMIT = 200;

const unavailable = (reason: string): Availability<never> => ({ state: "unavailable", reason });

/**
 * A runtime cursor carries the server's keyset cursor AND the exact window the first page returned, so
 * "Load more" never moves with the clock. It is opaque to callers.
 */
function encodeCursor(next: string, from: string, to: string): string {
  return JSON.stringify([next, from, to]);
}

function decodeCursor(raw: string): { cursor: string; from: string; to: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((part) => typeof part === "string")
    ) {
      return { cursor: parsed[0], from: parsed[1], to: parsed[2] };
    }
  } catch {
    // fall through
  }
  return null;
}

export function mapDnsEvent(row: DnsEventRow): NetworkEvent {
  return {
    id: row.event_id,
    at: row.observed_at,
    source: "dns",
    deviceId: row.device_id,
    deviceLabel:
      row.device_id === null ? UNRECOGNISED_DEVICE : (row.device_label ?? UNLABELLED_DEVICE),
    // No client address is ever returned, so none is shown.
    personLabel: null,
    // DNS identifies a device, never a person: even `person_label` is ignored.
    evidence: "observed",
    subject: row.domain,
    effect: row.effect,
    reason: row.reason_code,
    revision: row.policy_revision,
    correlationId: row.correlation_id,
    observations: 1,
    dns: {
      receivedAt: row.received_at,
      queryType: row.query_type,
      protocol: row.protocol,
      appliedRule: row.applied_rule,
      filterBlocked: row.filter_blocked,
      filterSourceId: row.filter_source_id,
      filterSourceKind: row.filter_source_kind,
      deniedAliasTarget: row.denied_alias_target,
    },
  };
}

const knownSources = (list: string[]): EventSource[] =>
  list.filter((s): s is EventSource => s === "dns" || s === "proxy" || s === "agent");

export function mapEventsPage(res: DnsEventsResponse): EventsPage {
  return {
    events: dedupe(res.rows.map(mapDnsEvent)),
    // By-host grouping does not exist on the server, and proxy/agent are listed as unsupported.
    capabilities: {
      sources: knownSources(res.sources),
      grouping: ["raw"],
      unrecognisedFilter: false,
    },
    total: res.total,
    hasMore: res.has_more && res.next_cursor !== null,
    nextCursor: res.next_cursor === null ? null : encodeCursor(res.next_cursor, res.from, res.to),
    retention: {
      keepDays: res.retention.keep_days,
      oldestStoredAt: res.retention.oldest_stored,
      storedCount: res.retention.stored_count,
      capCount: res.retention.cap_count,
    },
    truncated: res.truncated,
    paginationLimited: res.pagination_limited,
    observedOnly: res.observed_only,
  };
}

function dedupe(events: NetworkEvent[]): NetworkEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

function toRequest(q: EventsQuery): DnsEventsRequest {
  const decision = q.decision && q.decision !== "all" ? q.decision : q.effect;
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const search = q.search?.trim();
  const request: DnsEventsRequest = {
    limit: Math.min(Math.max(1, Math.trunc(q.limit)), MAX_LIMIT),
    source: "dns",
  };
  if (search) request.domain = search;
  if (q.deviceId) request.deviceId = q.deviceId;
  if (decision) request.allow = decision === "allow";
  if (cursor) {
    // The window is fixed by the first page; the caller's own from/to are ignored on later pages.
    request.cursor = cursor.cursor;
    request.from = cursor.from;
    request.to = cursor.to;
  } else {
    if (q.from) request.from = q.from;
    if (q.to) request.to = q.to;
    if (q.offset) request.offset = q.offset;
  }
  return request;
}

const RANGE_WINDOW = { "24h": "24h", "7d": "7d", "30d": "30d" } as const;

export function mapDnsStats(res: DnsStatsResponse, requested: DnsStatsQuery["range"]): DnsStats {
  return {
    total: res.total_queries,
    blocked: res.blocked,
    observations: res.total_queries,
    blockedObservations: res.blocked,
    window: {
      requested,
      actualStart: res.actual_window_start,
      actualEnd: res.actual_window_end,
      retainedDays: res.retention_days,
      // Conservative "may be incomplete", never proof of eviction or of its cause.
      shortened: res.shortened,
      limitedBy: res.shortened ? "unknown" : "none",
      requestedStart: res.window_start,
      requestedEnd: res.window_end,
    },
    // The server reports a total per bucket and nothing per-bucket about blocked queries.
    series: res.time_series.map((b) => ({ at: b.bucket, total: b.count })),
    topDomains: res.top_domains.map((d) => ({ domain: d.name, count: d.count })),
    topBlocked: res.top_blocked.map((d) => ({ domain: d.name, count: d.count })),
    allowed: res.allowed,
    unknownDeviceQueries: res.unknown_device_queries,
    topDevices: res.top_devices.map((d) => ({ deviceId: d.device_id, count: d.count })),
    topTruncated: {
      domains: res.top_domains_truncated,
      blocked: res.top_blocked_truncated,
      devices: res.top_devices_truncated,
    },
    retention: {
      keepDays: res.retention_days,
      oldestStoredAt: res.oldest_stored,
      newestStoredAt: res.newest_stored,
      storedCount: res.stored_count,
      capCount: res.cap_count,
    },
  };
}

/**
 * The production runtime for one household. Only DNS events and DNS statistics have a server API so
 * far (`GET dns/events`, `GET dns/stats`); every other method stays "unavailable". Nothing here is
 * invented: no cache hit/miss, no client address, no person, no proxy or agent history.
 */
export function createHttpRuntime(householdId: string): NetworkRuntimeSource {
  async function events(q: EventsQuery): Promise<Availability<EventsPage>> {
    // The server cannot filter on "no device": never filter an incomplete page on the client.
    if (q.unrecognisedDevices) {
      return unavailable("Filtering to unrecognised devices isn’t available for DNS observations.");
    }
    const unsupported =
      (q.source && q.source !== "all" && q.source !== "dns") || q.grouping === "by_host";
    try {
      if (unsupported) {
        // One row, only to learn capabilities and retention. No rows are shown and no count is claimed:
        // an unsupported source is not "no activity".
        const res = await api.dnsEvents(householdId, { limit: 1, source: "dns" });
        return {
          state: "ready",
          data: {
            ...mapEventsPage(res),
            events: [],
            total: null,
            hasMore: false,
            nextCursor: null,
          },
        };
      }
      return {
        state: "ready",
        data: mapEventsPage(await api.dnsEvents(householdId, toRequest(q))),
      };
    } catch (error) {
      if (isDnsEventsParamError(error)) return unavailable(error.message);
      throw error;
    }
  }

  async function dnsStats(q: DnsStatsQuery): Promise<Availability<DnsStats>> {
    const requested = q.requestedRange ?? q.range;
    const request: DnsStatsRequest = { window: RANGE_WINDOW[requested] };
    if (q.deviceId) request.deviceId = q.deviceId;
    try {
      return {
        state: "ready",
        data: mapDnsStats(await api.dnsStats(householdId, request), requested),
      };
    } catch (error) {
      if (isDnsEventsParamError(error)) return unavailable(error.message);
      throw error;
    }
  }

  return { ...unavailableRuntime, scope: `http:${householdId}`, events, dnsStats };
}
