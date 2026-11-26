import type {
  Availability,
  ConnectionCheck,
  Decision,
  DecisionQuery,
  DnsResponseMode,
  DnsSettingsPatch,
  DnsStats,
  DnsStatsQuery,
  DnsView,
  DomainMatch,
  DnsCacheClearResult,
  DnsUpdateOptions,
  EventsCapabilities,
  EventsPage,
  EventsQuery,
  IssueProxyCredentialInput,
  IssuedProxyCredential,
  NetworkEvent,
  ProxyAccessView,
  ProxyCredentialView,
  ProxySessionView,
  ProxyStatsQuery,
  StatsRange,
  StatsWindow,
  NetworkOverview,
  PolicyEdit,
  PolicyRule,
  PolicySnapshot,
  PolicyView,
  ProxyInspection,
  ProxyStats,
  ProxyView,
  ScopedRules,
  TrustState,
} from "@/features/network/runtime/types";
import { RuntimeConflictError } from "@/features/network/runtime/types";
import type { NetworkRuntimeSource } from "@/features/network/runtime/NetworkRuntimeSource";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const ready = <T>(data: T): Availability<T> => ({ state: "ready", data });
const notYet = (what: string): Availability<never> => ({
  state: "unavailable",
  reason: `${what} isn’t available on this server yet.`,
});

const rule = (
  id: string,
  effect: PolicyRule["effect"],
  match: DomainMatch,
  reason: string,
  schedule: PolicyRule["schedule"] = null,
): PolicyRule => ({ id, effect, match, reason, schedule });
const suffix = (value: string): DomainMatch => ({ kind: "suffix", value });
const exact = (value: string): DomainMatch => ({ kind: "exact", value });

function matches(match: DomainMatch, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  const v = match.value.toLowerCase();
  return match.kind === "exact" ? d === v : d === v || d.endsWith(`.${v}`);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Demo only: uses the browser clock rather than the household timezone. */
function inSchedule(schedule: PolicyRule["schedule"], at = new Date()): boolean {
  if (!schedule) return true;
  if (!schedule.days.includes(WEEKDAYS[at.getDay()])) return false;
  const minutes = at.getHours() * 60 + at.getMinutes();
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const from = toMin(schedule.from);
  const to = toMin(schedule.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

function baseSnapshot(): PolicySnapshot {
  return {
    revision: 14,
    savedAt: ago(60 * 3),
    timezone: "Australia/Sydney",
    defaultEffect: "allow",
    staleAfterSeconds: 900,
    baseline: [
      rule("b1", "deny", suffix("malware.example"), "Known malware host"),
      rule("b2", "deny", suffix("phishing.example"), "Known phishing host"),
    ],
    deviceDefaults: [
      {
        scopeId: "dev-tv",
        label: "Living room TV",
        rules: [rule("d1", "deny", suffix("mature.example"), "Not for a shared screen")],
      },
      {
        scopeId: "dev-tablet",
        label: "Kitchen tablet",
        rules: [
          rule("d2", "deny", suffix("social.example"), "No social media on the kitchen tablet"),
        ],
      },
    ],
    personRules: [
      {
        scopeId: "per-sam",
        label: "Sam",
        rules: [
          rule("p1", "deny", suffix("games.example"), "School nights", {
            days: ["sun", "mon", "tue", "wed", "thu"],
            from: "21:00",
            to: "07:00",
          }),
        ],
      },
      {
        scopeId: "per-jo",
        label: "Jo",
        rules: [rule("p2", "deny", suffix("social.example"), "Too young for social media")],
      },
    ],
    exceptions: [
      {
        id: "x1",
        scopeLabel: "Sam",
        match: exact("homework.example"),
        effect: "allow",
        reason: "Needed for a school project",
        approvedBy: "Alex",
        expiresAt: ahead(60 * 40),
      },
    ],
  };
}

function cloneSnapshot(s: PolicySnapshot): PolicySnapshot {
  return JSON.parse(JSON.stringify(s)) as PolicySnapshot;
}

/** Deny beats allow within a layer, so adding an allow can never quietly become "most permissive wins". */
function pick(rules: PolicyRule[], domain: string): PolicyRule | null {
  const hits = rules.filter((r) => matches(r.match, domain) && inSchedule(r.schedule));
  return hits.find((r) => r.effect === "deny") ?? hits[0] ?? null;
}

function decide(snapshot: PolicySnapshot, q: DecisionQuery): Decision {
  const base = {
    revision: snapshot.revision,
    identity: (q.personId ? "verified_person" : "unknown") as Decision["identity"],
  };
  const baselineDeny = snapshot.baseline.find(
    (r) => r.effect === "deny" && matches(r.match, q.domain),
  );
  if (baselineDeny)
    return {
      ...base,
      effect: "deny",
      layer: "baseline",
      rule: baselineDeny.id,
      reason: baselineDeny.reason,
    };

  const exception = snapshot.exceptions.find(
    (x) => new Date(x.expiresAt) > new Date() && matches(x.match, q.domain),
  );
  if (exception)
    return {
      ...base,
      effect: exception.effect,
      layer: "exception",
      rule: exception.id,
      reason: `${exception.reason} (approved by ${exception.approvedBy})`,
    };

  if (q.personId) {
    const hit = pick(
      snapshot.personRules.find((s) => s.scopeId === q.personId)?.rules ?? [],
      q.domain,
    );
    if (hit)
      return { ...base, effect: hit.effect, layer: "person", rule: hit.id, reason: hit.reason };
  }
  const device = pick(
    snapshot.deviceDefaults.find((s) => s.scopeId === q.deviceId)?.rules ?? [],
    q.domain,
  );
  if (device)
    return {
      ...base,
      effect: device.effect,
      layer: "device",
      rule: device.id,
      reason: device.reason,
    };

  return {
    ...base,
    effect: snapshot.defaultEffect,
    layer: "household_default",
    rule: null,
    reason: q.personId
      ? "No rule matched, so the household default applies."
      : "Nobody is verified on this device, so only device defaults apply. None matched, so the household default applies.",
  };
}

const DEVICE_IDS: Record<string, string> = {
  Desktop: "dev-desktop",
  Laptop: "dev-laptop",
  MacBook: "dev-macbook",
  "Living room TV": "dev-tv",
  "Kitchen tablet": "dev-tablet",
};

const RANGE_DAYS: Record<StatsRange, number> = { "24h": 1, "7d": 7, "30d": 30 };
const RANGE_STEP_MINUTES: Record<StatsRange, number> = { "24h": 60, "7d": 360, "30d": 1440 };
/** Days of data the demo gateway has actually stored, whatever the retention setting allows. */
const DEMO_STORED_DAYS = 14;
/** The proxy store keeps fewer rows, so its count cap evicts history sooner than the retention days do. */
const DEMO_PROXY_STORED_DAYS = 9;

/** What a request really covers: never more than is stored, and never more than the retention allows. */
function statsWindow(q: DnsStatsQuery, keepDays: number, storedDays = DEMO_STORED_DAYS) {
  const requested = q.requestedRange ?? q.range;
  const retainedDays = Math.max(1, Math.min(RANGE_DAYS[requested], storedDays, keepDays));
  const shortened = retainedDays < RANGE_DAYS[requested];
  const stepMinutes = RANGE_STEP_MINUTES[requested];
  const buckets = Math.max(1, Math.round((retainedDays * 1440) / stepMinutes));
  const window: StatsWindow = {
    requested,
    actualStart: ago(retainedDays * 1440),
    actualEnd: new Date().toISOString(),
    retainedDays,
    shortened,
    // Fewer days are stored than the retention allows only when the row count cap evicted them.
    limitedBy: !shortened ? "none" : keepDays <= storedDays ? "days" : "count_cap",
  };
  return { window, buckets, stepMinutes };
}

/** Deterministic per-device DNS statistics: a daily rhythm, a blocked share, and a few repeat domains. */
function buildStats(q: DnsStatsQuery, keepDays: number): DnsStats {
  const { window, buckets, stepMinutes } = statsWindow(q, keepDays);
  // A stable number per device, so each one looks different but never flickers between renders.
  const seed = [...(q.deviceId ?? "all")].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const scale = q.deviceId ? 0.6 + (seed % 7) / 10 : 3;
  const series = Array.from({ length: buckets }, (_, i) => {
    const hour = (i * (stepMinutes / 60)) % 24;
    const evening = Math.max(0, 1 - Math.abs(hour - 20) / 7);
    const total = Math.round((18 + 140 * evening + ((seed * (i + 3)) % 23)) * scale);
    const blocked = Math.round(total * (0.04 + ((seed + i * 5) % 9) / 100));
    return { at: ago((buckets - 1 - i) * stepMinutes), total, blocked };
  });
  const total = series.reduce((sum, b) => sum + b.total, 0);
  const blocked = series.reduce((sum, b) => sum + b.blocked, 0);
  const domains = [
    "video.example",
    "cdn.example",
    "news.example",
    "api.streaming.example",
    "time.example",
    "update.example",
    "images.example",
    "search.example",
  ];
  const blockedDomains = [
    "tracker.ads.example",
    "malware.example",
    "mature.example",
    "telemetry.example",
    "phishing.example",
  ];
  const spread = (names: string[], sum: number) =>
    names.map((domain, i) => ({
      domain,
      count: Math.max(
        1,
        Math.round((sum * (names.length - i)) / ((names.length * (names.length + 1)) / 2)),
      ),
    }));
  return {
    total,
    blocked,
    observations: total,
    blockedObservations: blocked,
    window,
    series,
    topDomains: spread(domains, total - blocked),
    topBlocked: spread(blockedDomains, blocked),
  };
}

/**
 * Deterministic per-device proxy statistics. Only some devices use the proxy, and what it blocks matches
 * the demo proxy events (malware.example for the MacBook, games.example for the desktop).
 */
function buildProxyStats(q: ProxyStatsQuery, inspectedShare: number, keepDays: number): ProxyStats {
  const { window, buckets, stepMinutes } = statsWindow(q, keepDays, DEMO_PROXY_STORED_DAYS);
  const seed = [...(q.deviceId ?? "all")].reduce((acc, ch) => acc + ch.charCodeAt(0) * 3, 0);
  const scale = q.deviceId ? 0.3 + (seed % 5) / 10 : 1.5;
  const series = Array.from({ length: buckets }, (_, i) => {
    const hour = (i * (stepMinutes / 60)) % 24;
    const daytime = Math.max(0, 1 - Math.abs(hour - 14) / 8);
    const total = Math.round((6 + 60 * daytime + ((seed * (i + 2)) % 11)) * scale);
    const blocked = Math.round(total * (0.03 + ((seed + i * 3) % 7) / 100));
    return { at: ago((buckets - 1 - i) * stepMinutes), total, blocked };
  });
  const total = series.reduce((sum, b) => sum + b.total, 0);
  const blocked = series.reduce((sum, b) => sum + b.blocked, 0);
  const spread = (names: string[], sum: number) =>
    names.map((domain, i) => ({
      domain,
      count: Math.max(
        1,
        Math.round((sum * (names.length - i)) / ((names.length * (names.length + 1)) / 2)),
      ),
    }));
  const hosts =
    q.deviceId === "dev-desktop"
      ? ["homework.example", "docs.example", "video.example", "cdn.example", "search.example", "update.example"]
      : ["news.example", "cdn.example", "api.streaming.example", "search.example", "images.example", "update.example"];
  const blockedHosts =
    q.deviceId === "dev-desktop"
      ? ["games.example", "tracker.ads.example", "telemetry.example"]
      : ["malware.example", "tracker.ads.example", "phishing.example", "telemetry.example", "mature.example", "ads2.example"];
  return {
    total,
    blocked,
    observations: total,
    blockedObservations: blocked,
    window,
    inspected: Math.round(total * inspectedShare),
    series,
    topHosts: spread(hosts, total - blocked),
    topBlocked: spread(blockedHosts, blocked),
  };
}

/** Demo name for a client that maps to no known device. */
const UNRECOGNISED = "Unrecognised";

/**
 * What the demo event store can answer. Remove a source or "by_host" to see the UI degrade the way it
 * will on a DNS-only backend.
 */
export const DEMO_EVENT_CAPABILITIES: EventsCapabilities = {
  sources: ["dns", "proxy", "agent"],
  grouping: ["raw", "by_host"],
};

function buildEvents(): NetworkEvent[] {
  const rows: Omit<NetworkEvent, "id" | "at" | "correlationId" | "observations">[][] = [];
  const visit = (
    device: string,
    person: string | null,
    evidence: NetworkEvent["evidence"],
    domain: string,
    effect: NetworkEvent["effect"],
    reason: string,
    sources: NetworkEvent["source"][],
  ) =>
    rows.push(
      sources.map((source) => ({
        source,
        deviceId: device === UNRECOGNISED ? null : (DEVICE_IDS[device] ?? device),
        deviceLabel: device === UNRECOGNISED ? "Unrecognised device" : device,
        ...(device === UNRECOGNISED ? { clientAddress: "192.168.1.77" } : {}),
        personLabel: person,
        evidence,
        subject: domain,
        effect,
        reason,
        revision: 14,
      })),
    );
  visit("Laptop", "Alex", "verified", "news.example", "allow", "Household default", [
    "agent",
    "dns",
  ]);
  visit("Desktop", "Sam", "verified", "games.example", "deny", "Sam: school nights", [
    "dns",
    "proxy",
  ]);
  visit("Desktop", null, "unknown", "video.example", "allow", "Household default", ["dns"]);
  visit(
    "Living room TV",
    null,
    "weak",
    "mature.example",
    "deny",
    "Living room TV: not for a shared screen",
    ["dns"],
  );
  visit(
    "Kitchen tablet",
    "Jo",
    "asserted",
    "social.example",
    "deny",
    "Kitchen tablet: no social media",
    ["dns"],
  );
  visit(
    "Desktop",
    "Sam",
    "verified",
    "homework.example",
    "allow",
    "Exception approved by Alex",
    ["dns", "proxy"],
  );
  visit(
    "Laptop",
    "Alex",
    "verified",
    "malware.example",
    "deny",
    "Household baseline: known malware host",
    ["dns"],
  );
  visit(UNRECOGNISED, null, "unknown", "telemetry.example", "deny", "Household baseline: tracker", [
    "dns",
  ]);
  visit("MacBook", "Jo", "verified", "news.example", "allow", "Household default", ["proxy"]);
  visit(
    "MacBook",
    "Jo",
    "verified",
    "malware.example",
    "deny",
    "Household baseline: known malware host",
    ["proxy"],
  );
  visit("MacBook", "Jo", "verified", "social.example", "deny", "Jo: too young for social media", [
    "proxy",
  ]);
  visit("MacBook", "Jo", "verified", "search.example", "allow", "Household default", ["proxy"]);
  const events: NetworkEvent[] = [];
  // 54 groups (69 events) spread over almost 14 days: dense recently, sparse further back.
  for (let i = 0; i < 54; i++) {
    const group = rows[i % rows.length];
    const correlationId = `cor-${i}`;
    group.forEach((row, k) =>
      events.push({
        ...row,
        id: `evt-${i}-${k}`,
        at: ago(i * 7 + i * i * 7 + k),
        correlationId,
        observations: 1,
      }),
    );
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

/** Fixtures for the hosted demo. Policy edits are held in memory so "saved is not applied" can be explored. */
export function createDemoNetworkRuntime(): NetworkRuntimeSource {
  const applied = baseSnapshot();
  let proposal: PolicySnapshot | null = (() => {
    const p = cloneSnapshot(applied);
    p.revision = 15;
    p.savedAt = ago(20);
    p.personRules[1].rules.push(
      rule("p3", "deny", suffix("chat.example"), "Chat apps are for older kids"),
    );
    return p;
  })();
  const allEvents = buildEvents();
  /** Only events inside the retention window are stored. */
  const storedEvents = () => {
    const cutoff = new Date(Date.now() - dnsState.retentionDays * 86_400_000).toISOString();
    return allEvents.filter((e) => e.at >= cutoff);
  };
  let nextId = 100;
  // DNS and proxy settings live here so the controls change what the demo shows.
  const dnsState = {
    responseMode: "nxdomain" as DnsResponseMode,
    cache: {
      enabled: true,
      minTtlSeconds: 30,
      maxTtlSeconds: 3600,
      negativeTtlSeconds: 300,
      serveStale: false,
    },
    rateLimit: 30 as number | null,
    retentionDays: 14,
    version: 7,
    // What the demo gateway last reported applying. It trails a save by a few seconds.
    reportedVersion: 7 as number | null,
    reportedAt: ago(2) as string | null,
    cacheEntries: 1840,
  };
  const PEOPLE: Record<string, string> = { "per-alex": "Alex", "per-sam": "Sam", "per-jo": "Jo" };
  const credentialStore: ProxyCredentialView[] = [
    {
      id: "c1",
      label: "Desktop",
      personId: "per-sam",
      personLabel: "Sam",
      deviceId: "dev-desktop",
      createdAt: ago(60 * 24 * 20),
      expiresAt: ahead(60 * 24 * 70),
      lastUsedAt: ago(3),
      revoked: false,
      revokedAt: null,
      scopes: ["proxy:connect"],
    },
    {
      id: "c2",
      label: "MacBook",
      personId: "per-jo",
      personLabel: "Jo",
      deviceId: "dev-macbook",
      createdAt: ago(60 * 24 * 10),
      expiresAt: null,
      lastUsedAt: ago(2),
      revoked: false,
      revokedAt: null,
      scopes: ["proxy:connect"],
    },
  ];
  const sessionStore: ProxySessionView[] = [
    {
      id: "s1",
      credentialId: "c1",
      deviceId: "dev-desktop",
      personLabel: "Sam",
      startedAt: ago(95),
      lastActiveAt: ago(3),
      expiresAt: ahead(60 * 6),
      evidence: "proxy sign-in",
      revoked: false,
    },
  ];
  const proxyAccessView = (): ProxyAccessView => ({
    credentials: credentialStore.map((c) => ({ ...c })),
    sessions: sessionStore.map((s) => ({ ...s })),
    enrollment: { available: true },
  });
  const revokeCredential = (id: string) => {
    const credential = credentialStore.find((c) => c.id === id);
    if (!credential || credential.revoked) return;
    credential.revoked = true;
    credential.revokedAt = new Date().toISOString();
    // A revoked credential can no longer hold a session open.
    for (const s of sessionStore) if (s.credentialId === id) s.revoked = true;
  };
  const inspectionState = { enabled: false, trust: "not_enabled" as TrustState };
  const inspection = (): ProxyInspection => ({
    enabled: inspectionState.enabled,
    trust: inspectionState.trust,
    // Only the public fingerprint is ever shown. The signing key never reaches the browser.
    caFingerprint: inspectionState.enabled
      ? "9F:2C:41:7A:B3:0E:D8:15:66:C2:9A:4B:F0:3D:81:27"
      : null,
    caNotAfter: inspectionState.enabled ? ahead(60 * 24 * 365 * 5) : null,
    trustingDevices: 0,
    totalDevices: 2,
    exceptions: [],
    pinnedApps: [
      {
        id: "a1",
        name: "Banking apps",
        note: "Pin their certificates and stop working when inspected.",
      },
    ],
  });

  const policyView = (): PolicyView => ({ applied, proposal });

  return {
    async overview() {
      return ready<NetworkOverview>({
        timezone: applied.timezone,
        revisions: {
          applied: applied.revision,
          proposal: proposal?.revision ?? null,
          proposalSavedAt: proposal?.savedAt ?? null,
        },
        gateways: [
          {
            id: "gw-dns",
            kind: "dns",
            name: "Vantyr DNS",
            online: true,
            lastSeenAt: ago(0.3),
            appliedRevision: applied.revision,
            acknowledgedAt: ago(60 * 3),
            verification: "unverified",
            verifiedAt: null,
            capabilities: [
              { id: "dns_filtering", coverage: "enforced" },
              { id: "local_records", coverage: "enforced" },
              {
                id: "encrypted_dns",
                coverage: "unsupported",
                detail:
                  "DNS over HTTPS and TLS aren’t offered yet. Clients use plain DNS on your network.",
              },
            ],
            warnings:
              proposal && proposal.revision > applied.revision
                ? [
                    {
                      id: "pending",
                      severity: "info",
                      message: `Saved revision ${proposal.revision} isn’t applied yet.`,
                      action: { label: "Review", to: "/network/policies" },
                    },
                  ]
                : [],
          },
          {
            id: "gw-proxy",
            kind: "proxy",
            name: "Vantyr Proxy",
            online: true,
            lastSeenAt: ago(0.5),
            appliedRevision: applied.revision,
            acknowledgedAt: ago(60 * 3),
            verification: "unverified",
            verifiedAt: null,
            capabilities: [
              { id: "http_proxy", coverage: "enforced" },
              {
                id: "https_inspection",
                coverage: "unsupported",
                detail: "HTTPS inspection is off. It is an explicit opt-in on the Proxy page.",
              },
            ],
            warnings: [],
          },
        ],
      });
    },

    async policy() {
      return ready(policyView());
    },

    async editPolicy(edit: PolicyEdit) {
      if (edit.kind === "discard_proposal") {
        proposal = null;
        return ready(policyView());
      }
      const draft = proposal ?? { ...cloneSnapshot(applied), revision: applied.revision + 1 };
      draft.savedAt = new Date().toISOString();
      if (edit.kind === "add_rule") {
        const added = { ...edit.rule, id: `n${nextId++}` };
        if (edit.layer === "baseline") draft.baseline.push(added);
        else {
          const list: ScopedRules[] =
            edit.layer === "device" ? draft.deviceDefaults : draft.personRules;
          list.find((s) => s.scopeId === edit.scopeId)?.rules.push(added);
        }
      } else {
        draft.baseline = draft.baseline.filter((r) => r.id !== edit.ruleId);
        for (const s of [...draft.deviceDefaults, ...draft.personRules])
          s.rules = s.rules.filter((r) => r.id !== edit.ruleId);
      }
      proposal = draft;
      return ready(policyView());
    },

    async explainDecision(q: DecisionQuery) {
      return ready(decide(applied, q));
    },

    async dns() {
      return ready<DnsView>({
        source: "demo",
        supportedSettings: {
          cache: true,
          serveExpired: true,
          ttlBounds: true,
          rateLimit: true,
          retention: true,
          responseMode: true,
        },
        settingsVersion: dnsState.version,
        settingsStatus: {
          saved: true,
          appliedVersion: dnsState.reportedVersion,
          reportedAt: dnsState.reportedAt,
        },
        filtering: ready({
          responseMode: dnsState.responseMode,
          allow: [exact("homework.example")],
          block: [suffix("malware.example"), suffix("phishing.example"), suffix("mature.example")],
        }),
        lists: notYet("Blocklist subscriptions"),
        rewrites: ready([
          { id: "r1", name: "nas.home.example", kind: "A", value: "192.168.1.20" },
          { id: "r2", name: "printer.home.example", kind: "A", value: "192.168.1.31" },
          { id: "r3", name: "media.home.example", kind: "CNAME", value: "nas.home.example" },
        ]),
        upstreams: ready({
          mode: "sequential",
          servers: [
            { address: "9.9.9.9", protocol: "udp", healthy: true },
            { address: "1.1.1.1", protocol: "udp", healthy: true },
          ],
          bootstrap: ["9.9.9.9"],
          fallback: ["1.1.1.1"],
        }),
        cache: ready({ entries: dnsState.cacheEntries, ...dnsState.cache }),
        access: ready({
          rateLimitPerSecond: dnsState.rateLimit,
          allowedClients: ["192.168.1.0/24"],
        }),
        encrypted: notYet("Encrypted DNS (DoH, DoT, DoQ)"),
        logging: ready({ retentionDays: dnsState.retentionDays, keepClientAddress: true }),
        services: notYet("Blocked services, safe search and categories"),
      });
    },

    async updateDns(patch: DnsSettingsPatch, options?: DnsUpdateOptions) {
      // Demo only: omitting the expected version means "the current one". The UI passes it explicitly.
      const expected = options?.expectedSettingsVersion ?? dnsState.version;
      if (expected !== dnsState.version) throw new RuntimeConflictError();
      if (patch.responseMode) dnsState.responseMode = patch.responseMode;
      if (patch.cache) Object.assign(dnsState.cache, patch.cache);
      if (patch.rateLimitPerSecond !== undefined) dnsState.rateLimit = patch.rateLimitPerSecond;
      if (patch.retentionDays !== undefined) dnsState.retentionDays = patch.retentionDays;
      dnsState.version += 1;
      const saved = dnsState.version;
      // The gateway reports back a moment later. Until then the saved version is not "applied".
      setTimeout(() => {
        if (dnsState.version >= saved) {
          dnsState.reportedVersion = saved;
          dnsState.reportedAt = new Date().toISOString();
        }
      }, 3000);
      return this.dns();
    },

    async clearDnsCache() {
      const entries = dnsState.cacheEntries;
      dnsState.cacheEntries = 0;
      return ready<DnsCacheClearResult>({ clearedAt: new Date().toISOString(), entries });
    },

    async dnsStats(q: DnsStatsQuery) {
      return ready<DnsStats>(buildStats(q, dnsState.retentionDays));
    },

    async proxyStats(q: ProxyStatsQuery) {
      // Nothing is inspected until devices report trusting the CA.
      const inspected = inspectionState.trust === "trusted" ? 0.6 : 0;
      return ready<ProxyStats>(buildProxyStats(q, inspected, dnsState.retentionDays));
    },

    async proxy() {
      return ready<ProxyView>({
        listener: ready({
          address: "192.168.1.10:3128",
          protocols: ["http", "connect"],
          destinationPolicy: "Private, loopback and metadata addresses are refused.",
        }),
        credentials: ready(
          credentialStore.map((c) => ({
            id: c.id,
            label: c.label,
            createdAt: c.createdAt,
            lastUsedAt: c.lastUsedAt,
            revoked: c.revoked,
          })),
        ),
        inspection: ready(inspection()),
      });
    },

    async revokeProxyCredential(id: string) {
      revokeCredential(id);
      return this.proxy();
    },

    async proxyAccess() {
      return ready(proxyAccessView());
    },

    async issueProxyCredential(input: IssueProxyCredentialInput) {
      const deviceLabel = Object.entries(DEVICE_IDS).find(([, id]) => id === input.deviceId)?.[0];
      const credential: ProxyCredentialView = {
        id: `c${nextId++}`,
        label: input.label.trim() || deviceLabel || "Proxy sign-in",
        personId: input.personId in PEOPLE ? input.personId : null,
        personLabel: PEOPLE[input.personId] ?? null,
        deviceId: input.deviceId,
        createdAt: new Date().toISOString(),
        expiresAt: ahead(input.expiresInHours * 60),
        lastUsedAt: null,
        revoked: false,
        revokedAt: null,
        scopes: ["proxy:connect"],
      };
      credentialStore.push(credential);
      // Returned once here; the store and every listing hold no secret.
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      const secret = `vpx_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      return ready<IssuedProxyCredential>({ credential: { ...credential }, secret });
    },

    async endProxySession(id: string) {
      const session = sessionStore.find((s) => s.id === id);
      if (session) session.revoked = true;
      return ready(proxyAccessView());
    },

    async revokeAllForPerson(personId: string) {
      const credentialIds = new Set<string>();
      for (const c of credentialStore) {
        if (c.personId !== personId) continue;
        credentialIds.add(c.id);
        revokeCredential(c.id);
      }
      for (const s of sessionStore) if (credentialIds.has(s.credentialId)) s.revoked = true;
      return ready(proxyAccessView());
    },

    async setInspection(enabled: boolean) {
      inspectionState.enabled = enabled;
      // Enabling only starts trust setup. It is never "trusted" until devices report that they trust the CA.
      inspectionState.trust = enabled ? "pending_trust" : "not_enabled";
      return ready(inspection());
    },

    async runCheck(_deviceId: string, _kind: "dns" | "proxy") {
      await new Promise((resolve) => setTimeout(resolve, 900 + Math.random() * 700));
      return ready<ConnectionCheck>({
        ok: true,
        ms: 12 + Math.round(Math.random() * 30),
        detail: "The gateway sees this device and can decide for it.",
      });
    },

    async events(q: EventsQuery) {
      const capabilities = DEMO_EVENT_CAPABILITIES;
      const stored = storedEvents().filter((e) => capabilities.sources.includes(e.source));
      const decision = q.decision && q.decision !== "all" ? q.decision : q.effect;
      const needle = q.search?.trim().toLowerCase();
      const filtered = stored.filter(
        (e) =>
          (q.unrecognisedDevices
            ? e.deviceId === null
            : !q.deviceId || e.deviceId === q.deviceId) &&
          (!needle || e.subject.toLowerCase().includes(needle)) &&
          (!q.source || q.source === "all" || e.source === q.source) &&
          (!decision || e.effect === decision) &&
          (!q.from || e.at >= q.from) &&
          (!q.to || e.at <= q.to),
      );
      // An unsupported source or grouping answers with nothing; `capabilities` says it is unsupported.
      const supported =
        (!q.source || q.source === "all" || capabilities.sources.includes(q.source)) &&
        (!q.grouping || capabilities.grouping.includes(q.grouping));
      let rows = supported ? filtered : [];
      if (supported && q.grouping === "by_host") {
        // One row per device + source + host + decision; `filtered` is newest first.
        const groups = new Map<string, NetworkEvent>();
        for (const e of filtered) {
          const key = `${e.deviceId ?? e.clientAddress}|${e.source}|${e.subject}|${e.effect}`;
          const g = groups.get(key);
          if (!g) {
            groups.set(key, {
              ...e,
              id: `grp-${e.id}`,
              observations: e.observations,
              firstSeenAt: e.at,
              lastSeenAt: e.at,
            });
          } else {
            g.observations += e.observations;
            g.firstSeenAt = e.at;
          }
        }
        rows = [...groups.values()];
      }
      const start = q.cursor ? Number(q.cursor) || 0 : (q.offset ?? 0);
      const slice = rows.slice(start, start + q.limit);
      const hasMore = start + q.limit < rows.length;
      const oldestStoredAt = stored.length ? stored[stored.length - 1].at : null;
      return ready<EventsPage>({
        events: slice,
        capabilities: { sources: [...capabilities.sources], grouping: [...capabilities.grouping] },
        total: rows.length,
        hasMore,
        nextCursor: hasMore ? String(start + q.limit) : null,
        retention: {
          keepDays: dnsState.retentionDays,
          oldestStoredAt,
          storedCount: stored.length,
          capCount: 50_000,
        },
        truncated: Boolean(q.from && oldestStoredAt && q.from < oldestStoredAt),
      });
    },
  };
}
