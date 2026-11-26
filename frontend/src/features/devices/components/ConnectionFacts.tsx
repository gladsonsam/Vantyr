import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";
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
  compact = false,
}: {
  title: string;
  connection: ConnectionSummary;
  /** What the last-seen time is the time of: "Last query", "Last request". */
  seenLabel: string;
  /** Extra cells, e.g. an action. */
  children?: ReactNode;
  /** Just the meta strip, with the evidence and the explanation in a help tip beside the status. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <DetailMetaStrip
        items={[
          {
            label: title,
            value: (
              <span className="inline-flex items-center gap-1">
                <ConnectionStatus state={connection.state} />
                <HelpTip label="About this connection">
                  {connection.provenance ? (
                    <span className="mb-1 block font-medium text-foreground">
                      {EVIDENCE[connection.provenance]}
                    </span>
                  ) : null}
                  {IDENTITY_NOTE[connection.kind]}
                </HelpTip>
              </span>
            ),
          },
          { label: seenLabel, value: <TimeAgo iso={connection.lastSeenAt} /> },
        ]}
      />
    );
  }
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
