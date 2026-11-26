import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { DetailMetaStrip } from "@/components/common/resource-detail/DetailMetaStrip";
import { DetailSection } from "@/components/common/resource-detail/DetailSection";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import type { ConnectionSummary } from "@/features/devices/lib/deviceModel";
import { IDENTITY_NOTE } from "@/features/devices/lib/identity";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { ConnectionStatus } from "./ConnectionStatus";

const EVIDENCE: Record<string, string> = {
  manual: "Added by hand",
  agent: "Reported by the agent",
  dns: "Seen by Vantyr DNS",
  proxy: "Seen by the Vantyr proxy",
  import: "Imported",
};

/** The top of a connection page: a meta strip, then the facts about this connection as key/value cells. */
export function ConnectionFacts({
  title,
  connection,
  seenLabel,
  children,
}: {
  title: string;
  connection: ConnectionSummary;
  /** What the last-seen time is the time of: "Last query", "Last request". */
  seenLabel: string;
  /** Extra cells, e.g. an action. */
  children?: ReactNode;
}) {
  return (
    <>
      <DetailMetaStrip
        items={[
          { label: title, value: <ConnectionStatus state={connection.state} /> },
          { label: seenLabel, value: <TimeAgo iso={connection.lastSeenAt} /> },
        ]}
      />
      <DetailSection title="About this connection" icon={Info}>
        <KeyValueGrid>
          {connection.provenance ? (
            <KeyValueCard label="Evidence" format="text">
              {EVIDENCE[connection.provenance]}
            </KeyValueCard>
          ) : null}
          {children}
        </KeyValueGrid>
        <p className="text-sm text-muted-foreground">{IDENTITY_NOTE[connection.kind]}</p>
      </DetailSection>
    </>
  );
}
