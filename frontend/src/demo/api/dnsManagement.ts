import { ApiError, applyDnsOperations, validateDnsOperations, type ApiClient } from "@/api";
import type {
  DnsDesiredView,
  DnsManagementConfig,
  DnsManagementPatchBody,
  DnsManagementView,
  DnsOperation,
  DnsRefreshResult,
  DnsSourceStatus,
  DnsStatusView,
  DnsSubscriptionSource,
} from "@/api/types";
import { asRecord } from "./helpers";

const GATEWAY = "gw-demo-dns";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const REFRESH_COOLDOWN_SECS = 60;

/** Stable fake digest (not cryptographic): 64 lowercase hex chars derived from the config JSON. */
function fakeDigest(value: unknown): string {
  const text = JSON.stringify(value);
  let out = "";
  for (let round = 0; out.length < 64; round++) {
    let h = 2166136261 ^ round;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

/** A source with defaults made explicit, so an omitted interval equals a null one. */
function canonicalSource(s: DnsSubscriptionSource): string {
  return JSON.stringify({
    id: s.id,
    url: s.url,
    format: s.format,
    enabled: s.enabled,
    interval_secs: s.interval_secs ?? null,
    max_stale_secs: s.max_stale_secs ?? null,
    metadata: {
      title: s.metadata.title,
      publisher: s.metadata.publisher,
      license: s.metadata.license,
    },
  });
}

/** In-memory DNS management for the demo gateway: seeded desired config v3, reported v2. */
export function demoDnsManagementApi(): Partial<ApiClient> {
  const seedConfig: DnsManagementConfig = {
    sources: [
      {
        id: "ads-basic",
        url: "https://lists.example.org/hosts.txt",
        format: "hosts",
        enabled: true,
        interval_secs: null,
        max_stale_secs: null,
        metadata: { title: "Example ads list", publisher: "Example Org", license: "CC0-1.0" },
      },
      {
        id: "trackers",
        url: "https://lists.example.org/trackers.txt",
        format: "abp",
        enabled: false,
        interval_secs: 43_200,
        max_stale_secs: null,
        metadata: { title: "Example tracker list", publisher: "Example Org", license: "CC0-1.0" },
      },
    ],
    catalog: {
      version: "2026-11-01",
      services: [
        {
          id: "video-site",
          label: "Video site",
          version: "1",
          domains: [{ type: "suffix", value: "video.example" }],
          source: "Operator-declared",
        },
        {
          id: "chat-app",
          label: "Chat app",
          version: "1",
          domains: [{ type: "exact", value: "chat.example" }],
          source: "Operator-declared",
        },
      ],
    },
    selected_services: ["video-site"],
  };

  let desired: DnsDesiredView = {
    config_version: 3,
    schema_version: 1,
    body_sha256: fakeDigest(seedConfig),
    config: seedConfig,
    created_at: ago(60 * 24 * 10),
    updated_at: ago(60 * 3),
    updated_by: "demo-user-admin",
  };

  const reportedSha = fakeDigest({ ...seedConfig, selected_services: [] });
  const sourceStatus: Record<string, DnsSourceStatus> = {
    "ads-basic": {
      id: "ads-basic",
      download: "fresh",
      checked_at: ago(5),
      fetched_at: ago(5),
      content_changed_at: ago(60 * 26),
      next_due_at: ahead(23 * 60),
      stale: false,
      failure_count: 0,
      cooldown_until: null,
      last_error: null,
      bytes: 1_258_291,
      rule_count: 48_210,
      downloaded_sha256: fakeDigest("ads-basic-body"),
    },
    trackers: {
      id: "trackers",
      download: "failed_with_last_good",
      checked_at: ago(12),
      fetched_at: ago(60 * 9),
      content_changed_at: ago(60 * 40),
      next_due_at: ahead(30),
      stale: false,
      failure_count: 3,
      cooldown_until: ahead(30),
      last_error: "connection timed out",
      bytes: 412_160,
      rule_count: 9_870,
      downloaded_sha256: fakeDigest("trackers-body"),
    },
  };

  const refreshes = new Map<
    string,
    { seq: number; createdAtMs: number; configVersion: number; expiresAt: string }
  >();
  let refreshSeq = 40;

  function view(): DnsManagementView {
    return {
      desired: structuredClone(desired),
      delivery: [
        {
          gateway_id: GATEWAY,
          delivered_version: 3,
          delivered_sha256:
            desired.config_version === 3 ? desired.body_sha256 : fakeDigest(seedConfig),
          delivered_at: ago(60 * 2),
          reported_version: 2,
          reported_sha256: reportedSha,
          reported_at: ago(20),
          status_received_at: ago(20),
        },
      ],
      supported: {
        scheduled_fetch: true,
        manual_refresh: true,
        service_blocking: "dns_domains",
        worker_consumer: "opt_in",
        safe_search: false,
        statistics: false,
        serve_stale: false,
        cache_ttl_controls: false,
        rate_limit: false,
        retention_controls: false,
        verified: false,
      },
    };
  }

  function status(): DnsStatusView {
    const sources = desired.config.sources.map(
      (s): DnsSourceStatus =>
        sourceStatus[s.id] ?? {
          id: s.id,
          download: "never_fetched",
          checked_at: null,
          fetched_at: null,
          content_changed_at: null,
          next_due_at: null,
          stale: false,
          failure_count: 0,
          cooldown_until: null,
          last_error: null,
          bytes: 0,
          rule_count: null,
          downloaded_sha256: null,
        },
    );
    return {
      desired_version: desired.config_version,
      gateways: [
        {
          gateway_id: GATEWAY,
          delivered_version: 3,
          reported_version: 2,
          status: {
            config_version: 2,
            body_sha256: reportedSha,
            report_id: "5f0c2d7e-1b3a-4c55-9a0e-7d1f4e2b8c10",
            reported_at: ago(20),
            received_at: ago(20),
            applied: {
              config_version: 2,
              body_sha256: reportedSha,
              generation: 12,
              filter_generation: 7,
              filter_identity: fakeDigest("filter-7").slice(0, 32),
              applied_at: ago(20),
              last_error: null,
            },
            sources: structuredClone(sources),
          },
        },
      ],
    };
  }

  return {
    dnsManagement: async () => view(),
    dnsStatus: async () => status(),
    dnsManagementPatch: async (_household, body: DnsManagementPatchBody) => {
      const b = asRecord(body);
      const expected = b.expected_config_version;
      const operations = (Array.isArray(b.operations) ? b.operations : []) as DnsOperation[];
      if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
        throw new ApiError("expected_config_version must be a non-negative integer", 400);
      }
      if (expected !== desired.config_version) {
        throw new ApiError("config changed; reload and try again", 409);
      }
      // Id checks in order, like the server: unknown id 404, add_list of an existing id is a no-op
      // when the source is identical and 409 when it differs. Everything else is validated (400).
      const effective: DnsOperation[] = [];
      let working = desired.config;
      for (const op of operations) {
        if (op.op === "add_list") {
          const found = working.sources.find((s) => s.id === op.source.id);
          if (found) {
            if (canonicalSource(found) === canonicalSource(op.source)) continue;
            throw new ApiError(
              `list "${op.source.id}" already exists with a different source`,
              409,
            );
          }
        } else if (op.op === "set_list" || op.op === "remove_list") {
          if (!working.sources.some((s) => s.id === op.id)) {
            throw new ApiError(`list "${op.id}" not found`, 404);
          }
        }
        effective.push(op);
        working = applyDnsOperations(working, [op]).config;
      }
      if (effective.length === 0) return { changed: false, ...view() };
      const errors = validateDnsOperations(effective, desired.config, expected);
      if (errors.length > 0) {
        throw new ApiError(errors[0].message, 400, { error: errors[0].message, fields: errors });
      }
      const { config } = applyDnsOperations(desired.config, effective);
      const before = JSON.stringify(desired.config);
      if (JSON.stringify(config) === before) return { changed: false, ...view() };
      desired = {
        ...desired,
        config_version: desired.config_version + 1,
        body_sha256: fakeDigest(config),
        config,
        updated_at: new Date().toISOString(),
        updated_by: "demo-user-admin",
      };
      return { changed: true, ...view() };
    },
    dnsListRefresh: async (_household, sourceId): Promise<DnsRefreshResult> => {
      const source = desired.config.sources.find((s) => s.id === sourceId);
      if (!source) throw new ApiError("list not found", 404);
      if (!source.enabled) throw new ApiError("list is disabled", 409);
      const existing = refreshes.get(sourceId);
      const nowMs = Date.now();
      if (existing && nowMs - existing.createdAtMs < REFRESH_COOLDOWN_SECS * 1000) {
        return {
          source_id: sourceId,
          refresh_seq: existing.seq,
          config_version: existing.configVersion,
          expires_at: existing.expiresAt,
          created: false,
          cooldown_secs: REFRESH_COOLDOWN_SECS,
        };
      }
      const entry = {
        seq: ++refreshSeq,
        createdAtMs: nowMs,
        configVersion: desired.config_version,
        expiresAt: ahead(10),
      };
      refreshes.set(sourceId, entry);
      return {
        source_id: sourceId,
        refresh_seq: entry.seq,
        config_version: entry.configVersion,
        expires_at: entry.expiresAt,
        created: true,
        cooldown_secs: REFRESH_COOLDOWN_SECS,
      };
    },
  };
}
