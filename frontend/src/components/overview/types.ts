import type { Agent, AgentLiveStatus } from "../../lib/types";
import type { OsKind } from "../common/OsBadge";

/** Connectivity/activity states for a fleet row (mirrors the legacy console set). */
export type FleetStatus = "connected" | "ok" | "active" | "afk" | "offline" | "blocked" | "danger";

export interface FleetRow extends Agent {
  appBlockEnabledCount: number | null;
  appBlockExamples: string[] | null;
  enrichmentStatus?: "ready" | "loading" | "missing" | "error";
  infoReportedAt?: string | null;
  windowReportedAt?: string | null;
  displayName: string;
  effectiveUptimeSecs?: number;
  idleSecs?: number;
  internetBlocked: boolean | null;
  internetBlockedSource: string | null;
  ip: string;
  lastWindow: string;
  liveStatus?: AgentLiveStatus;
  os: OsKind;
  status: FleetStatus;
  statusLabel: string;
  user: string;
  version: string | null;
  updateNeeded: boolean;
}
