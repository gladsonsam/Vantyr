import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { HelpTip } from "@/components/common/HelpTip";
import StatusMark, { type StatusMarkStatus } from "@/components/react-bits/StatusMark";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { useProxyQuery } from "@/features/network/runtime/useRuntimeQueries";
import type { TrustState } from "@/features/network/runtime/types";
import { cn } from "@/lib/utils";
import { OverviewCard } from "../OverviewCard";

const TITLE = "HTTPS inspection";

const TRUST: Record<TrustState, { label: string; mark: StatusMarkStatus; text: string }> = {
  not_enabled: { label: "Not set up", mark: "cancelled", text: "text-muted-foreground" },
  pending_trust: {
    label: "Waiting for devices to trust it",
    mark: "running",
    text: "text-warning",
  },
  trusted: { label: "Trusted", mark: "done", text: "text-success" },
  rotating: { label: "Rotating", mark: "running", text: "text-warning" },
  retired: { label: "Retired", mark: "cancelled", text: "text-muted-foreground" },
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 text-sm first:pt-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-right font-medium">{children}</dd>
    </div>
  );
}

/** Whether the proxy may look inside HTTPS, who trusts its certificate, and what affects this device. */
export function HttpsInspectionCard({ label }: { label: string }) {
  const query = useProxyQuery();
  if (query.isPending) return null;
  if (query.isError) return <UnavailableSection title={TITLE} reason="Couldn’t load the proxy." />;
  if (query.data.state === "unavailable") {
    return <UnavailableSection title={TITLE} reason={query.data.reason} />;
  }
  const inspection = query.data.data.inspection;
  if (inspection.state === "unavailable") {
    return <UnavailableSection title={TITLE} reason={inspection.reason} />;
  }
  const info = inspection.data;
  const trust = TRUST[info.trust];
  const exceptions = info.exceptions.filter((e) => e.scopeLabel === label);
  return (
    <OverviewCard
      title={TITLE}
      help={
        <HelpTip label="About HTTPS inspection">
          Inspection is an opt-in for the whole network. It only applies to devices that trust the
          Vantyr certificate authority, and apps that pin their own certificates stop working when
          inspected.
        </HelpTip>
      }
      action={
        <Link
          to="/network/proxy"
          className="inline-flex h-8 items-center rounded-md px-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Settings
        </Link>
      }
    >
      <dl className="divide-y divide-border/60">
        <Row label="Inspection">
          <span
            className={cn(
              "flex items-center gap-1.5",
              info.enabled ? "text-success" : "text-muted-foreground",
            )}
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            {info.enabled ? "On" : "Off"}
          </span>
        </Row>
        <Row label="Certificate">
          <span className={cn("flex items-center gap-2", trust.text)}>
            <StatusMark status={trust.mark} size={16} color="currentColor" />
            {trust.label}
          </span>
        </Row>
        <Row label="Devices trusting it">
          <span className="tabular-nums">
            {info.trustingDevices} of {info.totalDevices}
          </span>
        </Row>
        {exceptions.length > 0 ? (
          <Row label="Skipped for this device">
            <span className="min-w-0 truncate font-mono text-[0.8125rem]">
              {exceptions.map((e) => e.host).join(", ")}
              <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">
                until <TimeAgo iso={exceptions[0].expiresAt} />
              </span>
            </span>
          </Row>
        ) : null}
        {info.pinnedApps.length > 0 ? (
          <Row label="Apps you listed as not inspectable">
            <span className="min-w-0 truncate">
              {info.pinnedApps.map((a) => a.name).join(", ")}
            </span>
          </Row>
        ) : null}
      </dl>
    </OverviewCard>
  );
}
