import { ApiError, type ApiClient } from "@/api";
import type {
  DnsEventRow,
  DnsEventsRequest,
  DnsEventsResponse,
  DnsStatsRequest,
  DnsStatsResponse,
  DnsStatsWindowId,
} from "@/api/types";
import { buildEvents, buildStats } from "../networkRuntime";

const KEEP_DAYS = 14;
const CAP_COUNT = 5000;
/** The demo's DNS devices; the MacBook only uses the proxy, so it has no DNS observations. */
const DNS_DEVICES = ["dev-desktop", "dev-laptop", "dev-tv", "dev-tablet"];
const ALL_DEVICES = [...DNS_DEVICES, "dev-macbook"];

const WINDOW_SECS: Record<DnsStatsWindowId, number> = {
  "1h": 3600,
  "24h": 86_400,
  "7d": 7 * 86_400,
  "30d": 30 * 86_400,
};
const BUCKET_SECS: Record<DnsStatsWindowId, number> = {
  "1h": 300,
  "24h": 3600,
  "7d": 86_400,
  "30d": 86_400,
};

const bad = (message: string) => new ApiError(message, 400, { error: message });

/** A stable UUID-shaped id from a seed (not cryptographic). */
function fakeUuid(seed: string): string {
  let hex = "";
  for (let round = 0; hex.length < 32; round++) {
    let h = 2166136261 ^ round;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
    hex += (h >>> 0).toString(16).padStart(8, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Splits `total` over `weights` exactly (largest remainder), so parts always sum to `total`. */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest-- <= 0) break;
    out[i] += 1;
  }
  return out;
}

const encodeCursor = (ms: number, id: string) =>
  btoa(`${ms}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeCursor(raw: string): { ms: number; id: string } {
  try {
    const text = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const [ms, id] = text.split("|");
    if (id && Number.isFinite(Number(ms))) return { ms: Number(ms), id };
  } catch {
    // fall through
  }
  throw bad("invalid cursor");
}

/** DNS-only demo observations: no proxy/agent rows, one row with no device, never a person or address. */
function demoRows(): DnsEventRow[] {
  return buildEvents()
    .filter((e) => e.source === "dns")
    .map((e): DnsEventRow => {
      const baseline = e.effect === "deny" && e.reason.toLowerCase().includes("baseline");
      return {
        event_id: fakeUuid(e.id),
        time: e.at,
        observed_at: e.at,
        received_at: new Date(Date.parse(e.at) + 1500).toISOString(),
        source: "dns",
        device_id: e.deviceId,
        device_label: e.deviceId === null ? null : e.deviceLabel,
        person_label: null,
        evidence: "network_observation",
        domain: e.subject,
        effect: e.effect,
        allow: e.effect === "allow",
        reason: e.reason,
        reason_code: e.reason,
        policy_revision: e.revision,
        correlation_id: e.correlationId,
        protocol: "udp",
        query_type: "A",
        cache_state: "unknown",
        upstream: null,
        applied_rule: null,
        filter_blocked: baseline,
        filter_source_id: baseline ? "ads-basic" : null,
        filter_source_kind: baseline ? "list" : null,
        denied_alias_target: null,
        flags_rd: true,
        flags_cd: false,
        flags_ra: true,
        flags_ad: false,
      };
    })
    .sort(
      (a, b) => b.observed_at.localeCompare(a.observed_at) || b.event_id.localeCompare(a.event_id),
    );
}

function searchEvents(all: DnsEventRow[], q: DnsEventsRequest): DnsEventsResponse {
  if (q.cursor !== undefined && q.offset !== undefined) {
    throw bad("cursor and offset are mutually exclusive");
  }
  if (q.source !== undefined && q.source !== "dns") {
    throw bad(
      "only source=dns is supported; proxy and agent observation ingestion is not implemented",
    );
  }
  const limit = q.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad("limit must be 1..=200");
  const offset = q.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
    throw bad("offset must be 0..=100000");

  const now = Date.now();
  const toMs = q.to ? Date.parse(q.to) : now;
  const fromMs = q.from ? Date.parse(q.from) : now - 86_400_000;
  if (Number.isNaN(toMs)) throw bad("invalid to");
  if (Number.isNaN(fromMs)) throw bad("invalid from");
  if (fromMs > toMs) throw bad("from must not be after to");
  if (fromMs < now - 30 * 86_400_000 || toMs > now + 60_000) {
    throw bad("query window is outside the retention bound");
  }
  const needle = q.domain?.trim().toLowerCase();
  const matching = all.filter((r) => {
    const at = Date.parse(r.observed_at);
    return (
      at >= fromMs &&
      at <= toMs &&
      (!needle || r.domain.includes(needle)) &&
      (q.deviceId === undefined || r.device_id === q.deviceId) &&
      (q.reason === undefined || r.reason_code === q.reason) &&
      (q.allow === undefined || r.allow === q.allow)
    );
  });

  let start = offset;
  if (q.cursor !== undefined) {
    const after = decodeCursor(q.cursor);
    start = matching.findIndex((r) => {
      const at = Date.parse(r.observed_at);
      return at < after.ms || (at === after.ms && r.event_id < after.id);
    });
    if (start === -1) start = matching.length;
  }
  const rows = matching.slice(start, start + limit);
  const hasMore = start + rows.length < matching.length;
  const last = rows[rows.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(Date.parse(last.observed_at), last.event_id) : null;
  const nextOffset = q.cursor === undefined && hasMore ? start + rows.length : null;
  const oldest = all.length ? all[all.length - 1].observed_at : null;
  return {
    rows,
    total: matching.length,
    has_more: hasMore,
    next: nextCursor ?? (nextOffset === null ? null : String(nextOffset)),
    next_offset: nextOffset,
    next_cursor: nextCursor,
    pagination_limited: false,
    truncated: false,
    from: q.from ?? new Date(fromMs).toISOString(),
    to: q.to ?? new Date(toMs).toISOString(),
    observed_only: true,
    sources: ["dns"],
    unsupported_sources: ["proxy", "agent"],
    retention: {
      keep_days: KEEP_DAYS,
      oldest_stored: oldest,
      stored_count: all.length,
      cap_count: CAP_COUNT,
    },
  };
}

function statsFor(all: DnsEventRow[], q: DnsStatsRequest): DnsStatsResponse {
  const window = q.window ?? "24h";
  if (!(window in WINDOW_SECS)) throw bad("window must be 1h, 24h, 7d or 30d");
  if (q.deviceId !== undefined && !ALL_DEVICES.includes(q.deviceId)) {
    throw bad("device_id is not assigned in this household");
  }
  const now = Date.now();
  const windowSecs = WINDOW_SECS[window];
  const from = now - windowSecs * 1000;
  const noDnsData = q.deviceId === "dev-macbook";

  // Shape and scale come from the demo runtime's own statistics; an hour is a 24th of a day.
  const base = buildStats(
    { deviceId: q.deviceId, range: window === "1h" ? "24h" : window },
    KEEP_DAYS,
  );
  const total = noDnsData
    ? 0
    : window === "1h"
      ? Math.round(base.observations / 24)
      : base.observations;
  const blocked = noDnsData
    ? 0
    : Math.min(
        total,
        window === "1h" ? Math.round(base.blockedObservations / 24) : base.blockedObservations,
      );

  const bucketSecs = BUCKET_SECS[window];
  // The final bucket includes the requested upper boundary.
  const buckets = Math.floor(windowSecs / bucketSecs);
  const shape = Array.from(
    { length: buckets },
    (_, i) => base.series[Math.floor((i * base.series.length) / buckets)]?.total ?? 1,
  );
  const counts = apportion(total, shape);
  const timeSeries = counts.map((count, i) => ({
    bucket: new Date(from + i * bucketSecs * 1000).toISOString(),
    count,
  }));

  // Household-wide: four DNS devices plus the unmapped remainder, so the parts sum to the total.
  const parts = q.deviceId ? [total] : apportion(total, [40, 25, 20, 10, 5]);
  const unknown = q.deviceId ? 0 : parts[parts.length - 1];
  const topDevices = (q.deviceId ? [q.deviceId] : DNS_DEVICES)
    .map((device_id, i) => ({ device_id, count: parts[i] ?? 0 }))
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count);

  // Scoped to the device, like the real server: oldest/newest are of that device's observations.
  const scoped = q.deviceId ? all.filter((r) => r.device_id === q.deviceId) : all;
  const oldest = scoped.length ? scoped[scoped.length - 1].observed_at : null;
  const newest = scoped.length ? scoped[0].observed_at : null;
  const oldestMs = oldest ? Date.parse(oldest) : null;
  const newestMs = newest ? Date.parse(newest) : null;
  // Conservative, as on the server: empty/sparse data at either end, retention or a full cap.
  const shortened =
    all.length === 0 ||
    all.length >= CAP_COUNT ||
    oldestMs === null ||
    oldestMs > from ||
    newestMs === null ||
    newestMs < now - 60_000;

  return {
    window,
    window_secs: windowSecs,
    window_start: new Date(from).toISOString(),
    window_end: new Date(now).toISOString(),
    actual_window_start: new Date(
      oldestMs === null ? from : Math.max(oldestMs, from),
    ).toISOString(),
    actual_window_end: new Date(newestMs === null ? now : Math.min(newestMs, now)).toISOString(),
    retention_days: KEEP_DAYS,
    oldest_stored: oldest,
    newest_stored: newest,
    stored_count: all.length,
    cap_count: CAP_COUNT,
    shortened,
    device_id: q.deviceId ?? null,
    total_queries: total,
    allowed: total - blocked,
    blocked,
    top_domains: noDnsData
      ? []
      : base.topDomains.slice(0, 20).map((d) => ({ name: d.domain, count: d.count })),
    top_domains_truncated: false,
    top_blocked: noDnsData
      ? []
      : base.topBlocked.slice(0, 20).map((d) => ({ name: d.domain, count: d.count })),
    top_blocked_truncated: false,
    top_devices: topDevices,
    top_devices_truncated: false,
    unknown_device_queries: unknown,
    time_series: timeSeries,
    observed_only: true,
    sources: ["dns"],
    unsupported_sources: ["proxy", "agent"],
  };
}

/** Demo DNS observations and statistics: DNS-only, derived from the demo runtime's own fixtures. */
export function demoDnsEventsApi(): Partial<ApiClient> {
  const all = demoRows();
  return {
    dnsEvents: async (_household, query = {}) => searchEvents(all, query),
    dnsStats: async (_household, query = {}) => statsFor(all, query),
  };
}
