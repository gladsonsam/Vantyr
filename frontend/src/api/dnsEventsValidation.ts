import type { DnsEventsRequest, DnsStatsRequest, DnsStatsWindowId } from "@/api/types";

/**
 * Strict client-side mirror of the DNS events/stats query rules
 * (server/src/network/dns_events_dto.rs and dns_events_service.rs). The server stays authoritative
 * and answers 400 `{ "error": message }` for anything unknown or out of bounds; this refuses the same
 * inputs before a round trip. Unknown parameters are never sent because only known ones are built.
 */

export const DNS_EVENTS_LIMITS = {
  maxPageLimit: 200,
  defaultPageLimit: 50,
  maxOffset: 100_000,
  maxCursorLen: 128,
  maxDomainLen: 253,
  maxReasonLen: 64,
  maxAgeDays: 30,
  maxFutureSkewSecs: 60,
} as const;

export const DNS_STATS_WINDOWS: readonly DnsStatsWindowId[] = ["1h", "24h", "7d", "30d"];

export class DnsEventsParamError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "DnsEventsParamError";
    this.field = field;
  }
}

export function isDnsEventsParamError(e: unknown): e is DnsEventsParamError {
  return e instanceof DnsEventsParamError;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]+$/;
const SECRET_MARKERS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "bearer ",
  "cookie",
  "credential",
  "private_key",
  "session_id",
];

/** The server's free-text gate: no URLs, userinfo, query/fragment, `..`, control characters or secret markers. */
function cleanToken(value: string, max: number, domainShaped: boolean): boolean {
  if (value.length === 0 || value.length > max) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  const lower = value.toLowerCase();
  if (["://", "@", "?", "#", ".."].some((bad) => lower.includes(bad))) return false;
  if (SECRET_MARKERS.some((marker) => lower.includes(marker))) return false;
  if (domainShaped) return /^[A-Za-z0-9_.-]*$/.test(value.replace(/\.+$/, ""));
  return true;
}

function instant(field: string, raw: string): number {
  const ms = Date.parse(raw.trim());
  if (Number.isNaN(ms))
    throw new DnsEventsParamError(field, `${field} must be an RFC 3339 timestamp`);
  return ms;
}

function intIn(field: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DnsEventsParamError(field, `${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

export function validateDnsEventDeviceId(value: string): string {
  const trimmed = value.trim();
  if (!UUID.test(trimmed)) throw new DnsEventsParamError("device_id", "device_id must be a UUID");
  return trimmed;
}

/**
 * Builds the events query string (no leading `?`) or throws {@link DnsEventsParamError}. Refuses
 * cursor together with offset, `from` after `to`, `from` older than 30 days, `to` more than 60 s ahead.
 */
export function buildDnsEventsQuery(q: DnsEventsRequest, now: Date = new Date()): string {
  const p = new URLSearchParams();
  if (q.domain !== undefined && q.domain.trim() !== "") {
    const domain = q.domain.trim();
    if (
      !cleanToken(domain, DNS_EVENTS_LIMITS.maxDomainLen, true) ||
      domain.replace(/\.+$/, "") === ""
    ) {
      throw new DnsEventsParamError("domain", "Search with part of a domain name only");
    }
    p.set("domain", domain);
  }
  if (q.deviceId !== undefined) p.set("device_id", validateDnsEventDeviceId(q.deviceId));
  if (q.reason !== undefined && q.reason.trim() !== "") {
    const reason = q.reason.trim();
    if (!cleanToken(reason, DNS_EVENTS_LIMITS.maxReasonLen, false)) {
      throw new DnsEventsParamError("reason", "reason is not a valid reason code");
    }
    p.set("reason", reason);
  }
  if (q.allow !== undefined) p.set("allow", q.allow ? "true" : "false");
  if (q.source !== undefined) {
    if (q.source !== "dns")
      throw new DnsEventsParamError("source", "Only DNS observations are available");
    p.set("source", "dns");
  }
  let from: number | undefined;
  let to: number | undefined;
  if (q.from !== undefined) from = instant("from", q.from);
  if (q.to !== undefined) to = instant("to", q.to);
  const nowMs = now.getTime();
  const earliest = nowMs - DNS_EVENTS_LIMITS.maxAgeDays * 86_400_000;
  const latest = nowMs + DNS_EVENTS_LIMITS.maxFutureSkewSecs * 1000;
  if (from !== undefined && to !== undefined && from > to) {
    throw new DnsEventsParamError("from", "from must not be after to");
  }
  if (from !== undefined && from < earliest) {
    throw new DnsEventsParamError("from", "Observations are only kept for up to 30 days");
  }
  if (to !== undefined && to > latest) {
    throw new DnsEventsParamError("to", "to cannot be in the future");
  }
  // The server's default `from` is now - 24h; an explicit `to` older than that is a from > to error.
  if (q.from === undefined && to !== undefined && to < nowMs - 86_400_000) {
    throw new DnsEventsParamError("from", "Give a from time when to is more than 24 hours ago");
  }
  if (q.from !== undefined) p.set("from", q.from.trim());
  if (q.to !== undefined) p.set("to", q.to.trim());
  if (q.limit !== undefined) {
    p.set("limit", String(intIn("limit", q.limit, 1, DNS_EVENTS_LIMITS.maxPageLimit)));
  }
  if (q.cursor !== undefined && q.offset !== undefined) {
    throw new DnsEventsParamError("cursor", "cursor and offset cannot be used together");
  }
  if (q.offset !== undefined) {
    p.set("offset", String(intIn("offset", q.offset, 0, DNS_EVENTS_LIMITS.maxOffset)));
  }
  if (q.cursor !== undefined) {
    const cursor = q.cursor.trim();
    if (
      cursor.length === 0 ||
      cursor.length > DNS_EVENTS_LIMITS.maxCursorLen ||
      !CURSOR.test(cursor)
    ) {
      throw new DnsEventsParamError("cursor", "cursor is not valid");
    }
    p.set("cursor", cursor);
  }
  return p.toString();
}

/** Builds the stats query string (no leading `?`) or throws {@link DnsEventsParamError}. */
export function buildDnsStatsQuery(q: DnsStatsRequest): string {
  const p = new URLSearchParams();
  if (q.window !== undefined) {
    if (!DNS_STATS_WINDOWS.includes(q.window)) {
      throw new DnsEventsParamError("window", "window must be 1h, 24h, 7d or 30d");
    }
    p.set("window", q.window);
  }
  if (q.deviceId !== undefined) p.set("device_id", validateDnsEventDeviceId(q.deviceId));
  return p.toString();
}
