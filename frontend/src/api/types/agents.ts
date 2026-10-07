// ── Domain models ─────────────────────────────────────────────────────────────
//
// Row shapes are generated from the server's Rust structs (`./generated`, see
// server/docs/ARCHITECTURE.md) and re-exported here under the names call sites use. Only the
// response envelopes the server still builds with `json!` are written by hand below.

import type { MetricsBucket } from "./generated/MetricsBucket";
import type { FleetAgentSummary } from "./generated/FleetAgentSummary";

export type { AgentOverview as Agent } from "./generated/AgentOverview";
export type { WindowEventRow as WindowEvent } from "./generated/WindowEventRow";
export type { KeySessionRow as KeySession } from "./generated/KeySessionRow";
export type { UrlVisitRow as UrlVisit } from "./generated/UrlVisitRow";
export type { ActivityRow as ActivityEvent } from "./generated/ActivityRow";
export type { AgentSessionRow as AgentSessionEvent } from "./generated/AgentSessionRow";
export type { AgentSoftwareRow } from "./generated/AgentSoftwareRow";
export type { UrlTopRow } from "./generated/UrlTopRow";
export type { WindowTopRow } from "./generated/WindowTopRow";
export type { MetricsBucket as AgentMetricPoint } from "./generated/MetricsBucket";
export type { FleetAgentSummary } from "./generated/FleetAgentSummary";
export type { FleetWindow } from "./generated/FleetWindow";

// What the agent reports about itself (`agent_info`); only its allowlisted subset reaches
// the fleet summary, the whole snapshot reaches the Specs tab.
export type { AgentInfo } from "./generated/AgentInfo";
export type { NetworkAdapterInfo } from "./generated/NetworkAdapterInfo";
export type { DriveInfo } from "./generated/DriveInfo";
export type { MonitorInfo } from "./generated/MonitorInfo";
export type { AgentCapabilityInfo } from "./generated/AgentCapabilityInfo";

export interface FleetSummaryResponse {
  agents: Record<string, FleetAgentSummary>;
  missing: string[];
}

// ── Resource health history (CPU/mem/disk over time) ─────────────────────────

export interface AgentMetricsResponse {
  from: string;
  to: string;
  bucket_secs: number;
  points: MetricsBucket[];
}
