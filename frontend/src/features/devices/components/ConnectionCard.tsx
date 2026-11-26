import { Link } from "react-router-dom";
import { Button } from "@vantyr/ui/components/button";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
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

/** One of the ways this device connects: its state, what it can tell us, and where to go next. */
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
  return (
    <div className="flex h-full flex-col gap-4 rounded-xl border border-border/70 bg-card/10 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">{CONNECTION_LABEL[connection.kind]}</h3>
        <ConnectionStatus state={connection.state} />
      </div>
      <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2">
        <KeyValueCard label="Last seen" format="text">
          <TimeAgo iso={connection.lastSeenAt} />
        </KeyValueCard>
        {connection.provenance ? (
          <KeyValueCard label="Evidence" format="text">
            {EVIDENCE[connection.provenance]}
          </KeyValueCard>
        ) : null}
      </KeyValueGrid>
      <p className="text-sm text-muted-foreground">{IDENTITY_NOTE[connection.kind]}</p>
      {deviceId && connection.kind !== "agent" ? (
        <RunCheck deviceId={deviceId} kind={connection.kind} deviceLabel={deviceLabel} />
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="mt-auto self-start"
        nativeButton={false}
        render={<Link to={to} />}
      >
        Open {CONNECTION_LABEL[connection.kind]}
      </Button>
    </div>
  );
}
