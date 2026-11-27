/**
 * DNS management contract (`/api/network/households/{hid}/dns/...`). Config shapes are strict
 * server-side (unknown fields are rejected), so request bodies must be built exactly from these.
 * Provenance strings (publisher, license, evidence) are operator declarations, never verified.
 * The config version is its own counter, unrelated to policy revisions.
 */

export type DnsListFormat = "hosts" | "abp";

export interface DnsSourceMetadata {
  title: string;
  publisher: string;
  /** Operator-declared licence identifier or URL. Never compliance-verified. */
  license: string;
}

export interface DnsSubscriptionSource {
  /** 1..=64 chars of [A-Za-z0-9_-]. */
  id: string;
  /** HTTPS, <= 512 chars, no userinfo/query/fragment. */
  url: string;
  format: DnsListFormat;
  enabled: boolean;
  /** 300..=604800; null/omitted = server default (86400). */
  interval_secs?: number | null;
  /** 3600..=604800; null/omitted = server default (259200). */
  max_stale_secs?: number | null;
  metadata: DnsSourceMetadata;
}

export type DnsServiceDomain = { type: "exact"; value: string } | { type: "suffix"; value: string };

export interface DnsServiceDefinition {
  id: string;
  label: string;
  version: string;
  domains: DnsServiceDomain[];
  source?: string | null;
  evidence?: string | null;
  license?: string | null;
}

export interface DnsServiceCatalog {
  version: string;
  services: DnsServiceDefinition[];
}

export interface DnsManagementConfig {
  sources: DnsSubscriptionSource[];
  catalog: DnsServiceCatalog | null;
  selected_services: string[];
}

export interface DnsDesiredView {
  config_version: number;
  schema_version: number;
  body_sha256: string;
  config: DnsManagementConfig;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface DnsDeliveryView {
  gateway_id: string;
  delivered_version: number | null;
  delivered_sha256: string | null;
  delivered_at: string | null;
  reported_version: number | null;
  reported_sha256: string | null;
  reported_at: string | null;
  status_received_at: string | null;
}

/** What the server supports. `worker_consumer: "opt_in"` is not evidence of installation or verification. */
export interface DnsSupportedView {
  scheduled_fetch: boolean;
  manual_refresh: boolean;
  service_blocking: string;
  worker_consumer: string;
  safe_search: boolean;
  statistics: boolean;
  serve_stale: boolean;
  cache_ttl_controls: boolean;
  rate_limit: boolean;
  retention_controls: boolean;
  verified: boolean;
}

/** `desired: null` means nothing has been saved yet (not "unavailable"). */
export interface DnsManagementView {
  desired: DnsDesiredView | null;
  delivery: DnsDeliveryView[];
  supported: DnsSupportedView;
}

export interface DnsManagementPatchResult extends DnsManagementView {
  /** false for a no-op: no new config version was created. */
  changed: boolean;
}

/** Omitted keeps; `null` clears ONLY `interval_secs` / `max_stale_secs`; other fields are concrete. */
export interface DnsSourcePatch {
  url?: string;
  format?: DnsListFormat;
  enabled?: boolean;
  interval_secs?: number | null;
  max_stale_secs?: number | null;
  metadata?: DnsSourceMetadata;
}

export type DnsOperation =
  | { op: "add_list"; source: DnsSubscriptionSource }
  | { op: "remove_list"; id: string }
  | { op: "set_list"; id: string; patch: DnsSourcePatch }
  | { op: "set_catalog"; catalog: DnsServiceCatalog }
  | { op: "select_services"; ids: string[] };

export interface DnsManagementPatchBody {
  /** 0 creates version 1; otherwise must equal the stored version (409 when stale). */
  expected_config_version: number;
  operations: DnsOperation[];
}

export interface DnsRefreshResult {
  source_id: string;
  refresh_seq: number;
  config_version: number;
  expires_at: string;
  /** false when an unexpired request for the same source already existed. */
  created: boolean;
  cooldown_secs: number;
}

export const DNS_DOWNLOAD_STATES = [
  "never_fetched",
  "fresh",
  "stale",
  "disabled",
  "failed_with_last_good",
  "unavailable",
  "quarantined",
] as const;
export type DnsDownloadState = (typeof DNS_DOWNLOAD_STATES)[number];

export interface DnsSourceStatus {
  id: string;
  download: DnsDownloadState;
  checked_at: string | null;
  fetched_at: string | null;
  content_changed_at: string | null;
  next_due_at: string | null;
  stale: boolean;
  failure_count: number;
  cooldown_until: string | null;
  last_error: string | null;
  bytes: number;
  rule_count: number | null;
  downloaded_sha256: string | null;
}

export interface DnsAppliedView {
  config_version: number;
  body_sha256: string;
  generation: number;
  filter_generation: number;
  filter_identity: string;
  applied_at: string | null;
  last_error: string | null;
}

export interface DnsReportedStatus {
  config_version: number;
  body_sha256: string;
  report_id: string;
  reported_at: string;
  received_at: string;
  /** null = delivered but never applied. */
  applied: DnsAppliedView | null;
  sources: DnsSourceStatus[];
}

export interface DnsGatewayStatus {
  gateway_id: string;
  delivered_version?: number | null;
  reported_version?: number | null;
  /** null = no report from this gateway. */
  status: DnsReportedStatus | null;
}

export interface DnsStatusView {
  desired_version: number | null;
  gateways: DnsGatewayStatus[];
}
