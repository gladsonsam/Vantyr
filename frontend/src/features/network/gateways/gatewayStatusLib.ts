import type { StatusMarkStatus } from "@/components/react-bits/StatusMark";
import { parseReportedRevision, type GatewayObservation } from "@/api/queries/network";
import type { NetworkDesiredPolicy, NetworkGateway } from "@/api/types";

/** A gateway is "online" when its newest report is recent; it is a report, not a connection check. */
const ONLINE_WINDOW_MS = 5 * 60_000;

export type GatewayLiveness = "online" | "offline" | "never" | "revoked";

export function gatewayLiveness(gateway: NetworkGateway): GatewayLiveness {
  if (gateway.revoked_at) return "revoked";
  if (!gateway.last_seen_at) return "never";
  const seen = new Date(gateway.last_seen_at).getTime();
  return Number.isNaN(seen) || Date.now() - seen > ONLINE_WINDOW_MS ? "offline" : "online";
}

export const CAPABILITY_TEXT: Record<string, string> = {
  dns: "DNS filtering",
  proxy: "HTTP proxy",
  heartbeat: "Heartbeat",
  "config-read": "Reads policy",
};

export function capabilitiesFor(kind: NetworkGateway["kind"]): string[] {
  return [kind, "heartbeat", "config-read"];
}

export function revisionLabel(revision: number | null | undefined): string {
  return revision === null || revision === undefined ? "None" : `r${revision}`;
}

export function reportedRevisionLabel(raw: string | null): string {
  if (!raw) return "None reported";
  const parsed = parseReportedRevision(raw);
  return parsed === null ? raw : `r${parsed}`;
}

export interface DesiredVsReported {
  mark: StatusMarkStatus;
  title: string;
  detail: string;
}

/**
 * Desired, reported applied and verified are three different facts. Only the first two exist here,
 * and the second is the gateway's own claim. Nothing in this function can say "verified".
 */
export function desiredVsReported(
  desired: NetworkDesiredPolicy | null,
  observation: GatewayObservation | null,
): DesiredVsReported {
  if (!desired) {
    return {
      mark: "pending",
      title: "No policy assigned",
      detail: "Choose a saved revision for this gateway to be asked to run.",
    };
  }
  if (!observation) {
    return {
      mark: "pending",
      title: "Waiting for gateway to report",
      detail: `Desired ${revisionLabel(desired.revision)}. The gateway has not reported yet.`,
    };
  }
  if (observation.reportedFailure) {
    return {
      mark: "failed",
      title: "Gateway reported a failure",
      detail: observation.reportedFailure,
    };
  }
  const applied = parseReportedRevision(observation.reportedAppliedRevision);
  if (applied === desired.revision) {
    return {
      mark: "done",
      title: `Reported applied ${revisionLabel(applied)}`,
      detail: "The gateway says it applied this revision. Vantyr has not verified it.",
    };
  }
  return {
    mark: "pending",
    title: "Waiting for gateway to report the desired revision",
    detail: `Desired ${revisionLabel(desired.revision)}; reported applied ${reportedRevisionLabel(observation.reportedAppliedRevision)}.`,
  };
}
