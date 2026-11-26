import { Link } from "react-router-dom";
import { Button } from "@vantyr/ui/components/button";
import SpotlightCard from "@/components/react-bits/SpotlightCard";
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
    <SpotlightCard
      theme="dark"
      spotlightColor="#2bb6c9"
      intensity={0.25}
      className="!rounded-xl !p-0"
      style={{ "--spotlight-card-surface": "var(--ui-card)" } as React.CSSProperties}
    >
      <div className="flex h-full flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium">{CONNECTION_LABEL[connection.kind]}</h3>
          <ConnectionStatus state={connection.state} />
        </div>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Last seen</dt>
            <dd>
              <TimeAgo iso={connection.lastSeenAt} />
            </dd>
          </div>
          {connection.provenance ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Evidence</dt>
              <dd>{EVIDENCE[connection.provenance]}</dd>
            </div>
          ) : null}
        </dl>
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
    </SpotlightCard>
  );
}
