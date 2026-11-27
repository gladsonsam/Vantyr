import { useState } from "react";
import { Activity } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@vantyr/ui/components/button";
import { networkQueries } from "@/api/queries/network";
import { HelpTip } from "@/components/common/HelpTip";
import { QueryError } from "@/features/network/components/QueryError";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { reportedRevisionLabel } from "./gatewayStatusLib";

const STEP = 10;

/** Recent heartbeat reports, newest first. Every value is the worker’s own observation. */
export function GatewayReportsSection({
  household,
  gatewayId,
}: {
  household: string;
  gatewayId: string;
}) {
  const [limit, setLimit] = useState(STEP);
  const query = useQuery(networkQueries.gatewayReports(household, gatewayId, { limit }));
  const reports = query.data?.reports ?? [];
  return (
    <SettingsSection
      title="Recent reports"
      icon={<Activity />}
      help="Heartbeats from the worker, newest first. Reported desired and applied revisions are what it says; they are unverified."
    >
      {query.isPending ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <div className="p-4">
          <QueryError
            title="Reports"
            error={query.error}
            scope="network_admin"
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : reports.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Waiting for gateway to report.</p>
      ) : (
        <>
          <ul className="divide-y divide-border/50">
            {reports.map((report) => (
              <li key={report.id} className="space-y-1 px-5 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    Reported desired {reportedRevisionLabel(report.desired_revision)} · reported
                    applied {reportedRevisionLabel(report.applied_revision)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <TimeAgo iso={report.reported_at} />
                  </span>
                </div>
                <div className="text-[0.8125rem] text-muted-foreground">
                  Capabilities:{" "}
                  {report.capabilities.length ? report.capabilities.join(", ") : "none reported"}
                </div>
                {report.failure ? (
                  <div className="text-[0.8125rem] text-destructive">Failure: {report.failure}</div>
                ) : null}
              </li>
            ))}
          </ul>
          {reports.length >= limit ? (
            <div className="flex items-center justify-center gap-1 px-5 py-3">
              <Button variant="ghost" size="sm" onClick={() => setLimit(limit + STEP)}>
                Load more
              </Button>
              <HelpTip label="About paging">Older reports load from the server in pages.</HelpTip>
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
