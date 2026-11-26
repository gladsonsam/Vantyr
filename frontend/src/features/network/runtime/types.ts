/**
 * Vantyr Network runtime view models: gateways, policy, DNS, proxy and events.
 *
 * The server has no API for these yet. These types are the contract the UI is built against; a
 * {@link NetworkRuntimeSource} supplies them. The real source reports "unavailable"; only the demo
 * build supplies fixtures. Nothing here is inferred from a saved policy: "saved" and "enforced" are
 * separate fields on purpose.
 */

/** Something the server may not support yet. The UI shows `reason`, never a made-up value. */
export type Availability<T> =
  { state: "unavailable"; reason: string } | { state: "ready"; data: T };

/**
 * What a gateway can honestly claim for one capability. There is no "protected": a capability is
 * enforced only while a gateway reports it, and some traffic never passes a gateway at all.
 */
export type Coverage = "enforced" | "offline" | "unsupported" | "unknown" | "bypassed";

export type CapabilityId =
  "dns_filtering" | "local_records" | "encrypted_dns" | "http_proxy" | "https_inspection";

export interface GatewayCapability {
  id: CapabilityId;
  coverage: Coverage;
  /** Why, when it is not simply "enforced". */
  detail?: string;
}

export interface GatewayWarning {
  id: string;
  severity: "info" | "warning" | "critical";
  message: string;
  action?: { label: string; to: string };
}

/** `verified` needs a gateway-reported canary; an acknowledgement alone never earns it. */
export type Verification = "verified" | "unverified" | "failed";

export interface Gateway {
  id: string;
  kind: "dns" | "proxy";
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  /** Revision the gateway last acknowledged applying. */
  appliedRevision: number | null;
  acknowledgedAt: string | null;
  verification: Verification;
  verifiedAt: string | null;
  capabilities: GatewayCapability[];
  warnings: GatewayWarning[];
}

export interface RevisionState {
  /** Newest revision any gateway has acknowledged. */
  applied: number | null;
  /** A saved proposal. Saving never enforces it. */
  proposal: number | null;
  proposalSavedAt: string | null;
}

export interface NetworkOverview {
  timezone: string;
  revisions: RevisionState;
  gateways: Gateway[];
}

// ── Policy ──────────────────────────────────────────────────────────────────

export type Effect = "allow" | "deny";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface DomainMatch {
  kind: "exact" | "suffix";
  value: string;
}

export interface ScheduleWindow {
  days: Weekday[];
  /** 24-hour "HH:MM" in the household timezone. */
  from: string;
  to: string;
}

export interface PolicyRule {
  id: string;
  effect: Effect;
  match: DomainMatch;
  reason: string;
  schedule: ScheduleWindow | null;
}

export interface ScopedRules {
  scopeId: string;
  label: string;
  rules: PolicyRule[];
}

export interface PolicyException {
  id: string;
  scopeLabel: string;
  match: DomainMatch;
  effect: Effect;
  reason: string;
  approvedBy: string;
  expiresAt: string;
}

export interface PolicySnapshot {
  revision: number;
  savedAt: string;
  timezone: string;
  defaultEffect: Effect;
  /** Seconds a gateway keeps enforcing its last known policy when the server is unreachable. */
  staleAfterSeconds: number;
  /** Household baseline. Deny only, and nothing below it can override it. */
  baseline: PolicyRule[];
  deviceDefaults: ScopedRules[];
  /** Applies only to a verified person on an assigned device. */
  personRules: ScopedRules[];
  exceptions: PolicyException[];
}

export interface PolicyView {
  /** What gateways were told to enforce, or `null` before any revision was applied. */
  applied: PolicySnapshot | null;
  /** Saved but not yet applied. Never enforced until a gateway acknowledges it. */
  proposal: PolicySnapshot | null;
}

export interface DecisionQuery {
  deviceId: string;
  /** `null` is a first-class answer: nobody verified is using the device. */
  personId: string | null;
  domain: string;
}

export interface Decision {
  effect: Effect;
  layer: "baseline" | "exception" | "person" | "device" | "household_default";
  rule: string | null;
  reason: string;
  revision: number;
  identity: "verified_person" | "unknown";
}

export type PolicyEdit =
  | {
      kind: "add_rule";
      layer: "baseline" | "device" | "person";
      scopeId: string | null;
      rule: Omit<PolicyRule, "id">;
    }
  | { kind: "remove_rule"; ruleId: string }
  | { kind: "discard_proposal" };

// ── DNS ─────────────────────────────────────────────────────────────────────

export interface DnsUpstream {
  address: string;
  protocol: "udp" | "tcp" | "dot" | "doh";
  healthy: boolean;
}

export interface DnsListSubscription {
  id: string;
  name: string;
  entries: number;
  lastRefreshedAt: string | null;
  error: string | null;
}

export interface DnsRewrite {
  id: string;
  name: string;
  kind: "A" | "AAAA" | "CNAME";
  value: string;
}

export interface DnsView {
  filtering: Availability<{
    responseMode: "nxdomain" | "refused" | "sinkhole";
    allow: DomainMatch[];
    block: DomainMatch[];
  }>;
  lists: Availability<DnsListSubscription[]>;
  rewrites: Availability<DnsRewrite[]>;
  upstreams: Availability<{
    mode: "sequential" | "parallel" | "fastest";
    servers: DnsUpstream[];
    bootstrap: string[];
    fallback: string[];
  }>;
  cache: Availability<{
    enabled: boolean;
    entries: number;
    minTtlSeconds: number;
    maxTtlSeconds: number;
    negativeTtlSeconds: number;
    serveStale: boolean;
  }>;
  access: Availability<{ rateLimitPerSecond: number | null; allowedClients: string[] }>;
  encrypted: Availability<
    { transport: "doh" | "dot" | "doq"; coverage: Coverage; certificateExpiresAt: string | null }[]
  >;
  logging: Availability<{ retentionDays: number; keepClientAddress: boolean }>;
  services: Availability<{ blockedServices: string[]; safeSearch: boolean; categories: string[] }>;
}

// ── Proxy ───────────────────────────────────────────────────────────────────

export interface ProxyView {
  listener: Availability<{
    address: string;
    protocols: ("http" | "connect")[];
    destinationPolicy: string;
  }>;
  credentials: Availability<
    { id: string; label: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }[]
  >;
  inspection: Availability<ProxyInspection>;
}

export type TrustState = "not_enabled" | "pending_trust" | "trusted" | "rotating" | "retired";

export interface ProxyInspection {
  enabled: boolean;
  trust: TrustState;
  /** Public certificate fingerprint only. The signing key never reaches the browser. */
  caFingerprint: string | null;
  caNotAfter: string | null;
  /** Devices that currently report trusting this CA. */
  trustingDevices: number;
  totalDevices: number;
  exceptions: { id: string; scopeLabel: string; host: string; expiresAt: string; reason: string }[];
  pinnedApps: { id: string; name: string; note: string }[];
}

// ── Events ──────────────────────────────────────────────────────────────────

export type EventSource = "dns" | "proxy" | "agent";
export type IdentityEvidence = "verified" | "asserted" | "weak" | "unknown";

export interface NetworkEvent {
  id: string;
  at: string;
  source: EventSource;
  deviceId: string;
  deviceLabel: string;
  personLabel: string | null;
  evidence: IdentityEvidence;
  /** A domain for DNS. DNS is a domain decision, not a visited URL. */
  subject: string;
  effect: Effect;
  reason: string;
  revision: number;
  /** Events describing one action share this id, so one visit is not counted three times. */
  correlationId: string;
}

export interface EventsQuery {
  /** Only this device's events. */
  deviceId?: string;
  /** Case-insensitive match on the domain or host. */
  search?: string;
  source?: EventSource;
  effect?: Effect;
  cursor?: string;
  limit: number;
}

export interface EventsPage {
  events: NetworkEvent[];
  nextCursor: string | null;
  retention: { days: number; maxEvents: number; maxBytes: number };
  usage: { events: number; bytes: number };
}

// ── DNS statistics ──────────────────────────────────────────────────────────

export type StatsRange = "24h" | "7d" | "30d";

export interface DnsStatsQuery {
  /** Only this device's queries; omit for the whole household. */
  deviceId?: string;
  range: StatsRange;
}

export interface DomainCount {
  domain: string;
  count: number;
}

/** Counts of DNS queries answered, bucketed over time. These are domain decisions, not page visits. */
export interface DnsStats {
  total: number;
  blocked: number;
  /** Oldest first; evenly spaced buckets across the range. */
  series: { at: string; total: number; blocked: number }[];
  topDomains: DomainCount[];
  topBlocked: DomainCount[];
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** The result of asking a gateway to confirm it can still reach, and decide for, a device. */
export interface ConnectionCheck {
  ok: boolean;
  ms: number;
  detail: string;
}

export type DnsResponseMode = "nxdomain" | "refused" | "sinkhole";

export interface DnsSettingsPatch {
  responseMode?: DnsResponseMode;
  cache?: Partial<{
    enabled: boolean;
    minTtlSeconds: number;
    maxTtlSeconds: number;
    negativeTtlSeconds: number;
    serveStale: boolean;
  }>;
  rateLimitPerSecond?: number | null;
  retentionDays?: number;
}
