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
  EventsPage,
  EventsQuery,
  NetworkEvent,
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

/** Deterministic per-device DNS statistics: a daily rhythm, a blocked share, and a few repeat domains. */
function buildStats(q: DnsStatsQuery): DnsStats {
  const buckets = q.range === "24h" ? 24 : q.range === "7d" ? 28 : 30;
  const stepMinutes = q.range === "24h" ? 60 : q.range === "7d" ? 360 : 1440;
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
    series,
    topDomains: spread(domains, total - blocked),
    topBlocked: spread(blockedDomains, blocked),
  };
}

/**
 * Deterministic per-device proxy statistics. Only some devices use the proxy, and what it blocks matches
 * the demo proxy events (malware.example for the MacBook, games.example for the desktop).
 */
function buildProxyStats(q: DnsStatsQuery, inspectedShare: number): ProxyStats {
  const buckets = q.range === "24h" ? 24 : q.range === "7d" ? 28 : 30;
  const stepMinutes = q.range === "24h" ? 60 : q.range === "7d" ? 360 : 1440;
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
    inspected: Math.round(total * inspectedShare),
    series,
    topHosts: spread(hosts, total - blocked),
    topBlocked: spread(blockedHosts, blocked),
  };
}

function buildEvents(): NetworkEvent[] {
  const rows: Omit<NetworkEvent, "id" | "at" | "correlationId">[][] = [];
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
        deviceId: DEVICE_IDS[device] ?? device,
        deviceLabel: device,
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
  for (let i = 0; i < 48; i++) {
    const group = rows[i % rows.length];
    const correlationId = `cor-${i}`;
    group.forEach((row, k) =>
      events.push({ ...row, id: `evt-${i}-${k}`, at: ago(i * 7 + k), correlationId }),
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
  const events = buildEvents();
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
  };
  const revokedCredentials = new Set<string>();
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
        cache: ready({ entries: 1840, ...dnsState.cache }),
        access: ready({
          rateLimitPerSecond: dnsState.rateLimit,
          allowedClients: ["192.168.1.0/24"],
        }),
        encrypted: notYet("Encrypted DNS (DoH, DoT, DoQ)"),
        logging: ready({ retentionDays: dnsState.retentionDays, keepClientAddress: true }),
        services: notYet("Blocked services, safe search and categories"),
      });
    },

    async updateDns(patch: DnsSettingsPatch) {
      if (patch.responseMode) dnsState.responseMode = patch.responseMode;
      if (patch.cache) Object.assign(dnsState.cache, patch.cache);
      if (patch.rateLimitPerSecond !== undefined) dnsState.rateLimit = patch.rateLimitPerSecond;
      if (patch.retentionDays !== undefined) dnsState.retentionDays = patch.retentionDays;
      return this.dns();
    },

    async dnsStats(q: DnsStatsQuery) {
      return ready<DnsStats>(buildStats(q));
    },

    async proxyStats(q: DnsStatsQuery) {
      // Nothing is inspected until devices report trusting the CA.
      const inspected = inspectionState.trust === "trusted" ? 0.6 : 0;
      return ready<ProxyStats>(buildProxyStats(q, inspected));
    },

    async proxy() {
      return ready<ProxyView>({
        listener: ready({
          address: "192.168.1.10:3128",
          protocols: ["http", "connect"],
          destinationPolicy: "Private, loopback and metadata addresses are refused.",
        }),
        credentials: ready(
          [
            {
              id: "c1",
              label: "Desktop",
              createdAt: ago(60 * 24 * 20),
              lastUsedAt: ago(3),
              revoked: false,
            },
            {
              id: "c2",
              label: "MacBook",
              createdAt: ago(60 * 24 * 10),
              lastUsedAt: ago(2),
              revoked: false,
            },
          ].map((c) => ({ ...c, revoked: revokedCredentials.has(c.id) })),
        ),
        inspection: ready(inspection()),
      });
    },

    async revokeProxyCredential(id: string) {
      revokedCredentials.add(id);
      return this.proxy();
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
      const filtered = events.filter(
        (e) =>
          (!q.deviceId || e.deviceId === q.deviceId) &&
          (!q.search || e.subject.toLowerCase().includes(q.search.toLowerCase())) &&
          (!q.source || e.source === q.source) &&
          (!q.effect || e.effect === q.effect),
      );
      const start = q.cursor ? Number(q.cursor) : 0;
      const slice = filtered.slice(start, start + q.limit);
      const next = start + q.limit < filtered.length ? String(start + q.limit) : null;
      return ready<EventsPage>({
        events: slice,
        nextCursor: next,
        retention: { days: dnsState.retentionDays, maxEvents: 50_000, maxBytes: 20_000_000 },
        usage: { events: events.length, bytes: events.length * 420 },
      });
    },
  };
}
