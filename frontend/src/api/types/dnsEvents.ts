/**
 * Durable DNS observations and statistics. Wire shapes of
 * `GET /api/network/households/{hid}/dns/events` and `.../dns/stats` (grant `network_admin` or
 * `network_events`), mirroring server/src/network/dns_events_service.rs. Both answers are DIRECT
 * (no wrapper object). Everything here is an OBSERVATION a DNS worker reported: not a visit, not a
 * verified person, not proof of enforcement, and the history can have gaps (a bounded worker queue
 * can drop rows, workers can be offline). No client address is ever returned.
 */

export type DnsObservationSource = "dns";
export type DnsUnsupportedSource = "proxy" | "agent";

/** `person_label` is always null and `evidence` is always this weak value. */
export type DnsEventEvidence = "network_observation";

export type DnsEventFilterSourceKind = "list" | "service";

/** One stored DNS observation. */
export interface DnsEventRow {
  /** Unique per household; the dedupe key when paging. */
  event_id: string;
  /** Alias of `observed_at` (identical value). */
  time: string;
  /** Worker-reported occurrence time, RFC 3339. */
  observed_at: string;
  /** Server clock when the observation was stored. */
  received_at: string;
  source: DnsObservationSource;
  /** `null`: the worker could not map the query to an inventory device. No address is returned. */
  device_id: string | null;
  /** Plain inventory label; `null` when `device_id` is null (or the label join found nothing). */
  device_label: string | null;
  /** Always `null`: DNS identifies a device, never a person. */
  person_label: string | null;
  evidence: DnsEventEvidence;
  /** The DNS query name only. */
  domain: string;
  /** Derived from `allow`. A policy decision, not answer success or enforcement. */
  effect: "allow" | "deny";
  allow: boolean;
  /** Same value as `reason_code`. */
  reason: string;
  reason_code: string;
  policy_revision: number | null;
  correlation_id: string | null;
  /** udp|tcp|dot|doh|doq|dnscrypt|h3|unknown. Kept as a string: the server allowlist can grow. */
  protocol: string;
  /** A|AAAA|CNAME|... (server allowlist). */
  query_type: string;
  /** hit|miss|stale|bypass|unknown on the wire; the production worker always sends `unknown`. Never display hit/miss. */
  cache_state: string;
  /** Always null from the production worker. */
  upstream: string | null;
  applied_rule: string | null;
  filter_blocked: boolean;
  filter_source_id: string | null;
  filter_source_kind: DnsEventFilterSourceKind | null;
  denied_alias_target: string | null;
  flags_rd: boolean;
  flags_cd: boolean;
  flags_ra: boolean;
  flags_ad: boolean;
}

/** Store state at read time. The age/count limits come from operator environment config, not UI settings. */
export interface DnsEventsRetention {
  keep_days: number;
  oldest_stored: string | null;
  stored_count: number;
  cap_count: number;
}

export interface DnsEventsResponse {
  rows: DnsEventRow[];
  /** Matching rows in the same snapshot as this page. Between pages live changes are normal. */
  total: number;
  has_more: boolean;
  /** The cursor in cursor mode, the next offset as a string in offset mode, null at the end. */
  next: string | null;
  next_offset: number | null;
  /** Opaque keyset cursor (<= 128 chars, microsecond precision). Present whenever `has_more`. */
  next_cursor: string | null;
  /** Offset paging hit the 100000 cap. */
  pagination_limited: boolean;
  /**
   * Conservative "may be incomplete" signal (offset cap reached, or the household count cap is full so
   * earlier matches may have been evicted). Not proof of eviction and not a cause.
   */
  truncated: boolean;
  /** The effective window. Send these back with `cursor` so a moving default "now" never changes the query. */
  from: string;
  to: string;
  observed_only: true;
  sources: DnsObservationSource[];
  unsupported_sources: DnsUnsupportedSource[];
  retention: DnsEventsRetention;
}

/** Client-side filters for the events route. Every field is optional. */
export interface DnsEventsRequest {
  /** Substring of the query name (sent as `domain`; `q` is an alias the client does not use). */
  domain?: string;
  /** Household-wide when omitted. */
  deviceId?: string;
  /** Exact reason code. */
  reason?: string;
  /** `true` = allowed decisions, `false` = denied decisions. */
  allow?: boolean;
  /** Only `dns` exists. */
  source?: DnsObservationSource;
  /** RFC 3339, inclusive. At most 30 days in the past; `to` at most 60 s in the future. */
  from?: string;
  to?: string;
  /** 1..200, default 50. */
  limit?: number;
  /** 0..100000. Mutually exclusive with `cursor`. */
  offset?: number;
  /** Opaque, from a previous response's `next_cursor`. Mutually exclusive with `offset`. */
  cursor?: string;
}

export type DnsStatsWindowId = "1h" | "24h" | "7d" | "30d";

export interface DnsStatsRequest {
  /** Default `24h`. */
  window?: DnsStatsWindowId;
  /** Must be a device assigned in the household. */
  deviceId?: string;
}

export interface DnsNameCount {
  name: string;
  count: number;
}

/** The server returns only the id and a count: no label, and the id is never null here. */
export interface DnsDeviceCount {
  device_id: string;
  count: number;
}

export interface DnsSeriesBucket {
  /** Bucket start, RFC 3339. Includes the requested upper boundary in the final bucket. */
  bucket: string;
  count: number;
}

export interface DnsStatsResponse {
  window: DnsStatsWindowId;
  window_secs: number;
  /** The REQUESTED window. Use it for chart axes and empty states. */
  window_start: string;
  window_end: string;
  /** Bounds of the retained observation timestamps inside the window; falls back to the requested bounds when empty. Not proof of continuous coverage. */
  actual_window_start: string;
  actual_window_end: string;
  retention_days: number;
  /** Scoped to `device_id` when one was requested. */
  oldest_stored: string | null;
  newest_stored: string | null;
  /** Household-wide. */
  stored_count: number;
  cap_count: number;
  /**
   * Conservative "this window may be incomplete" signal: empty or sparse data, retention, or a full
   * count cap can all set it. Not proof of eviction and not a cause.
   */
  shortened: boolean;
  device_id: string | null;
  total_queries: number;
  allowed: number;
  blocked: number;
  /** Capped at 20. */
  top_domains: DnsNameCount[];
  top_domains_truncated: boolean;
  top_blocked: DnsNameCount[];
  top_blocked_truncated: boolean;
  top_devices: DnsDeviceCount[];
  top_devices_truncated: boolean;
  /** Queries with no mapped device. */
  unknown_device_queries: number;
  /** Sums to `total_queries`. Empty buckets are real zeros. At most 30 buckets. */
  time_series: DnsSeriesBucket[];
  observed_only: true;
  sources: DnsObservationSource[];
  unsupported_sources: DnsUnsupportedSource[];
}
