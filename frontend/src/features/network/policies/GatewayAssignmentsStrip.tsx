import { Radio } from "lucide-react";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { UnavailableSection } from "@/features/network/components/AvailabilityGate";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { HelpTip } from "@/components/common/HelpTip";
import { Spinner } from "@vantyr/ui/components/spinner";
import { parseReportedRevision, type GatewayStatus } from "@/api/queries/network";
import { cn } from "@/lib/utils";

/** Reported revision as the worker sent it: "r14" when it parses, otherwise the raw text. */
function reportedLabel(raw: string | null): string {
  const n = parseReportedRevision(raw);
  return n !== null ? `r${n}` : (raw ?? "none");
}

function Dot({ tone }: { tone: "ok" | "warn" | "idle" | "bad" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-[0.4rem] size-1.5 shrink-0 rounded-full",
        tone === "ok" && "bg-success",
        tone === "warn" && "bg-warning",
        tone === "bad" && "bg-destructive",
        tone === "idle" && "bg-muted-foreground/60",
      )}
    />
  );
}

function Line({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "idle" | "bad";
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 text-[0.8125rem] leading-5">
      <Dot tone={tone} />
      <span
        className={cn(
          "min-w-0",
          tone === "ok" && "text-success",
          tone === "warn" && "text-warning",
          tone === "bad" && "text-destructive",
          tone === "idle" && "text-muted-foreground",
        )}
      >
        {children}
      </span>
    </div>
  );
}

function GatewayRow({ status }: { status: GatewayStatus }) {
  const { gateway, desired, observation } = status;
  const reportedApplied = observation
    ? parseReportedRevision(observation.reportedAppliedRevision)
    : null;
  const inactive = Boolean(gateway.revoked_at) || !gateway.enabled;
  const differs = desired !== null && observation !== null && reportedApplied !== desired.revision;
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-sm font-semibold">
          {gateway.label}{" "}
          <span className="text-xs font-normal text-muted-foreground uppercase">
            {gateway.kind}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {gateway.revoked_at ? (
            "Revoked"
          ) : !gateway.enabled ? (
            "Disabled"
          ) : observation ? (
            <>
              Last report <TimeAgo iso={observation.reportedAt} />
            </>
          ) : (
            "Has not reported"
          )}
        </span>
      </div>
      <div className="mt-2 grid gap-1.5 md:grid-cols-3 md:gap-x-6">
        <div className="space-y-0.5">
          <div className="text-xs font-medium text-muted-foreground">Desired</div>
          {desired ? (
            <Line tone="ok">
              r{desired.revision} · assigned <TimeAgo iso={desired.assigned_at} />
            </Line>
          ) : (
            <Line tone="idle">Nothing assigned</Line>
          )}
        </div>
        <div className="space-y-0.5">
          <div className="text-xs font-medium text-muted-foreground">Reported applied</div>
          {observation?.reportedAppliedRevision ? (
            <Line tone={observation.reportedFailure ? "bad" : differs ? "warn" : "ok"}>
              {reportedLabel(observation.reportedAppliedRevision)} · Reported, unverified
            </Line>
          ) : (
            <Line tone="idle">{observation ? "Reports nothing applied" : "No report yet"}</Line>
          )}
        </div>
        <div className="space-y-0.5">
          <div className="text-xs font-medium text-muted-foreground">Verified</div>
          <Line tone="idle">Not verified — no verification signal available</Line>
        </div>
      </div>
      {observation?.reportedFailure ? (
        <p className="mt-2 text-[0.8125rem] text-destructive">
          Gateway says: {observation.reportedFailure}
        </p>
      ) : differs && !inactive ? (
        <p className="mt-2 text-[0.8125rem] text-muted-foreground">
          The gateway has not reported applying r{desired.revision} yet. It fetches the desired
          revision when it next checks in.
        </p>
      ) : null}
    </li>
  );
}

/**
 * Saved, desired, reported applied: per gateway, side by side. Everything the gateway says about
 * itself is a report; nothing here is verified or enforced.
 */
export function GatewayAssignmentsStrip({
  statuses,
  isPending,
  isError,
}: {
  statuses: GatewayStatus[];
  isPending: boolean;
  isError: boolean;
}) {
  if (isError) {
    return <UnavailableSection title="Gateways" reason="Couldn’t load the gateways." />;
  }
  return (
    <SettingsSection
      title="Gateways"
      description="Desired is what an admin assigned. Reported applied is what the gateway says it ran."
      icon={<Radio />}
      action={
        <HelpTip label="About desired and reported">
          Saving a revision does nothing on its own. Assigning it makes it the gateway’s desired
          revision; the gateway fetches it and reports back. That report is the gateway’s own claim.
          No check confirms the rules actually work.
        </HelpTip>
      }
    >
      {isPending ? (
        <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : statuses.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          No gateways yet. Add one on the Gateways page to assign a revision to it.
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {statuses.map((s) => (
            <GatewayRow key={s.gateway.id} status={s} />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
