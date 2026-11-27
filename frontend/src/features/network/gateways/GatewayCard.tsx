import { Link } from "react-router-dom";
import { ChevronRight, Network, Server } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import type { GatewayStatus } from "@/api/queries/network";
import { GatewayCapabilityRows } from "./GatewayCapabilityRows";
import { gatewayLiveness, reportedRevisionLabel, revisionLabel } from "./gatewayStatusLib";
import { EnabledStatus, LivenessStatus } from "./gatewayStatus";

export function ReportedAppliedLabel() {
  return (
    <span className="flex items-center gap-1.5">
      Reported applied
      <HelpTip label="About reported applied">
        What the gateway says it applied. It is the worker’s own claim: Vantyr does not verify it,
        and it is not proof that anything is enforced.
      </HelpTip>
    </span>
  );
}

/** One gateway: is it reporting, desired revision versus what it reports, and what it claims to do. */
export function GatewayCard({ status }: { status: GatewayStatus }) {
  const { gateway, observation, desired } = status;
  const Icon = gateway.kind === "dns" ? Server : Network;
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card/10">
      <Link
        to={`/network/gateways/${gateway.id}`}
        className="flex items-center justify-between gap-4 px-5 py-4 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{gateway.label}</div>
            <div className="text-[0.8125rem] text-muted-foreground">
              {gateway.kind === "dns" ? "DNS gateway" : "Proxy gateway"} · last report{" "}
              <TimeAgo iso={gateway.last_seen_at} />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <EnabledStatus enabled={gateway.enabled} />
          <LivenessStatus liveness={gatewayLiveness(gateway)} />
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
        </div>
      </Link>
      <div className="space-y-3 border-t border-border/50 p-4">
        <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2">
          <KeyValueCard label="Desired revision" format="text">
            {revisionLabel(desired?.revision)}
          </KeyValueCard>
          <KeyValueCard label={<ReportedAppliedLabel />} format="text">
            {observation
              ? reportedRevisionLabel(observation.reportedAppliedRevision)
              : "Not reported yet"}
          </KeyValueCard>
        </KeyValueGrid>
        {observation?.reportedFailure ? (
          <p role="status" className="text-sm text-destructive">
            Last reported failure: {observation.reportedFailure}
          </p>
        ) : null}
      </div>
      <div className="border-t border-border/50">
        <GatewayCapabilityRows
          kind={gateway.kind}
          reported={observation?.reportedCapabilities ?? gateway.capabilities}
        />
      </div>
    </section>
  );
}
