import { Link } from "react-router-dom";
import { HelpTip } from "@/components/common/HelpTip";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { IDENTITY_NOTE, CONNECTION_LABEL } from "@/features/devices/lib/identity";
import type { ConnectionSummary } from "@/features/devices/lib/deviceModel";
import { ConnectionStatus } from "./ConnectionStatus";
import { RunCheck } from "./RunCheck";

const EVIDENCE: Record<string, string> = {
  manual: "Added by hand",
  agent: "Reported by the agent",
  dns: "Seen by Vantyr DNS",
  proxy: "Seen by the Vantyr proxy",
  import: "Imported",
};

/** One of the ways this device connects, as a small card that opens its tab. */
export function ConnectionCard({
  connection,
  to,
  deviceId,
  deviceLabel,
}: {
  connection: ConnectionSummary;
  deviceId: string | null;
  deviceLabel: string;
  /** The sub-page for this connection. */
  to: string;
}) {
  const label = CONNECTION_LABEL[connection.kind];
  return (
    <div className="relative flex min-w-0 items-start justify-between gap-2 rounded-lg bg-muted/30 p-5">
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-1">
          <Link
            to={to}
            aria-label={`Open ${label}`}
            className="text-base font-semibold outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
          >
            {label}
          </Link>
          <HelpTip label={`About ${label}`} className="relative z-10">
            {connection.provenance ? (
              <span className="mb-1 block font-medium text-foreground">
                {EVIDENCE[connection.provenance]}
              </span>
            ) : null}
            {IDENTITY_NOTE[connection.kind]}
          </HelpTip>
        </div>
        <ConnectionStatus state={connection.state} />
        <div className="text-sm text-muted-foreground">
          Last seen <TimeAgo iso={connection.lastSeenAt} />
        </div>
      </div>
      {deviceId && connection.kind !== "agent" ? (
        <div className="relative z-10 -mr-2 -mt-2">
          <RunCheck deviceId={deviceId} kind={connection.kind} deviceLabel={deviceLabel} compact />
        </div>
      ) : null}
    </div>
  );
}
