import type { Agent, AgentLiveStatus } from "../../lib/types";
import type { ConsoleStatus, OsKind } from "../ui/console";

export interface FleetRow extends Agent {
  appBlockEnabledCount: number | null;
  appBlockExamples: string[] | null;
  displayName: string;
  effectiveUptimeSecs?: number;
  idleSecs?: number;
  internetBlocked: boolean | null;
  internetBlockedSource: string | null;
  ip: string;
  lastWindow: string;
  liveStatus?: AgentLiveStatus;
  os: OsKind;
  status: ConsoleStatus;
  statusLabel: string;
  user: string;
  version: string | null;
  updateNeeded: boolean;
}
