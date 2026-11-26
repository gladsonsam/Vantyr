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

/**
 * What the DNS gateway reports about the settings version it runs. "Applied" is gateway-reported and
 * never independently verified.
 */
export interface DnsSettingsStatus {
  /** The latest settings are durably stored on the server. */
  saved: boolean;
  /** The settings version the gateway last reported applying, or `null` if it never has. */
  appliedVersion: number | null;
  /** When the gateway reported `appliedVersion`. */
  reportedAt: string | null;
}

export interface DnsView {
  /** Where these settings came from. Only the demo supplies them today; the real source is unavailable. */
  source?: "demo" | "server";
  /** Counter for DNS runtime settings only. It is not the policy revision. Used for compare-and-set. */
  settingsVersion: number;
  settingsStatus: DnsSettingsStatus;
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

// ── Proxy access ────────────────────────────────────────────────────────────

/**
 * A proxy sign-in credential: how the proxy tells which person is using a device. It is NOT any of:
 * a gateway worker token (how a gateway authenticates to the server), a BYOD setup grant (how a device
 * is enrolled), or HTTPS-inspection CA trust (what lets the proxy read encrypted traffic).
 */
export interface ProxyCredentialView {
  id: string;
  /** Equals the device label when issued for one device, so a device's Proxy tab can match by label. */
  label: string;
  personLabel: string | null;
  deviceId: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  scopes: string[];
}

/** A live proxy sign-in. The evidence it earns is "proxy sign-in", nothing stronger. */
export interface ProxySessionView {
  id: string;
  credentialId: string;
  deviceId: string;
  personLabel: string;
  startedAt: string;
  lastActiveAt: string;
  expiresAt: string;
  evidence: "proxy sign-in";
  revoked: boolean;
}

export interface ProxyAccessView {
  credentials: ProxyCredentialView[];
  sessions: ProxySessionView[];
  enrollment: { available: boolean; reason?: string };
}

export interface IssueProxyCredentialInput {
  personId: string;
  deviceId: string | null;
  label: string;
  expiresInHours: number;
}

export interface IssuedProxyCredential {
  credential: ProxyCredentialView;
  /** Shown once, when issued. It is never listed again and cannot be recovered. */
  secret: string;
}

// ── Events ──────────────────────────────────────────────────────────────────

export type EventSource = "dns" | "proxy" | "agent";
export type IdentityEvidence = "verified" | "asserted" | "weak" | "unknown";

export interface NetworkEvent {
  id: string;
  /** For a grouped row, the most recent observation. */
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
  /**
   * How many times the gateway observed this host or domain in this row (1 for a raw row). These are
   * observations of a domain or host, not browser visits or page history.
   */
  observations: number;
  /** Only on grouped rows (`grouping: "by_host"`). */
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export type EventsGrouping = "raw" | "by_host";

export interface EventsQuery {
  /** Only this device's events. Household-wide when omitted. */
  deviceId?: string;
  /** Case-insensitive substring match on the domain or host. */
  search?: string;
  source?: EventSource | "all";
  decision?: Effect | "all";
  /** Older spelling of `decision` for a single effect. */
  effect?: Effect;
  /** ISO timestamps, inclusive. */
  from?: string;
  to?: string;
  /** "raw" is one row per observation; "by_host" collapses repeats of a host per device and decision. */
  grouping?: EventsGrouping;
  cursor?: string;
  /** Skips this many rows. Ignored when `cursor` is set. */
  offset?: number;
  limit: number;
}

export interface EventsRetention {
  keepDays: number;
  oldestStoredAt: string | null;
  storedCount: number;
  /** The most rows the store keeps, or `null` when there is no row cap. */
  capCount: number | null;
}

export interface EventsPage {
  events: NetworkEvent[];
  /** Rows matching the query, or `null` when the source cannot count cheaply. */
  total?: number | null;
  hasMore: boolean;
  nextCursor: string | null;
  retention: EventsRetention;
  /** The requested range reaches back further than anything stored. */
  truncated: boolean;
}

// ── DNS statistics ──────────────────────────────────────────────────────────

export type StatsRange = "24h" | "7d" | "30d";

export interface DnsStatsQuery {
  /** Only this device's queries; omit for the whole household. */
  deviceId?: string;
  range: StatsRange;
  /** Same meaning as `range`; wins when both are set. */
  requestedRange?: StatsRange;
}

export type ProxyStatsQuery = DnsStatsQuery;

/** What a statistics response actually covers. Never claim `requested` when `shortened` is true. */
export interface StatsWindow {
  requested: StatsRange;
  actualStart: string;
  actualEnd: string;
  /** Whole days of data that exist inside the request. */
  retainedDays: number;
  shortened: boolean;
}

export interface DomainCount {
  domain: string;
  count: number;
}

/** Counts of DNS queries answered, bucketed over time. These are domain decisions, not page visits. */
export interface DnsStats {
  total: number;
  blocked: number;
  /** Same figures as `total`/`blocked`, named for what they are: observations, not visits. */
  observations: number;
  blockedObservations: number;
  window: StatsWindow;
  /** Oldest first; evenly spaced buckets across the range. */
  series: { at: string; total: number; blocked: number }[];
  topDomains: DomainCount[];
  topBlocked: DomainCount[];
}

/** Counts of proxy requests decided, bucketed over time. Hosts only: never full URLs or page contents. */
export interface ProxyStats {
  total: number;
  blocked: number;
  observations: number;
  blockedObservations: number;
  window: StatsWindow;
  /** Requests whose HTTPS traffic was inspected (needs a trusted CA on the device). */
  inspected: number;
  /** Oldest first; evenly spaced buckets across the range. */
  series: { at: string; total: number; blocked: number }[];
  /** `domain` holds the destination host. */
  topHosts: DomainCount[];
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

/** Pass as `expectedSettingsVersion` so a stale write is rejected rather than overwriting someone else. */
export interface DnsUpdateOptions {
  expectedSettingsVersion?: number;
}

export interface DnsCacheClearResult {
  clearedAt: string;
  /** Cache entries that were dropped. */
  entries: number;
}

/** A compare-and-set write lost to a newer version. Reload before retrying. */
export class RuntimeConflictError extends Error {
  readonly kind = "conflict";
  constructor(message = "The DNS settings changed since you loaded them") {
    super(message);
    this.name = "RuntimeConflictError";
  }
}
