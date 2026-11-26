import StatusMark from "@/components/react-bits/StatusMark";
import { cn } from "@/lib/utils";
import { type DesiredVsReported, type GatewayLiveness } from "./gatewayStatusLib";

const LIVENESS: Record<GatewayLiveness, { text: string; label: string }> = {
  online: { text: "text-success", label: "Reporting" },
  offline: { text: "text-warning", label: "Not reporting" },
  never: { text: "text-muted-foreground", label: "Never reported" },
  revoked: { text: "text-destructive", label: "Revoked" },
};

export function LivenessStatus({ liveness }: { liveness: GatewayLiveness }) {
  const { text, label } = LIVENESS[liveness];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", text)}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Whether the gateway is allowed to fetch policy and heartbeat. Separate from reporting: a disabled
 * gateway is not the same thing as one that stopped reporting.
 */
export function EnabledStatus({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm font-medium",
        enabled ? "text-success" : "text-muted-foreground",
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

/** The mark deliberately uses a neutral colour for "done": a report is not a verification. */
export function DesiredStatusMark({ state }: { state: DesiredVsReported }) {
  return (
    <div className="flex items-start gap-3">
      <StatusMark
        status={state.mark}
        size={22}
        color="var(--muted-foreground)"
        doneColor="var(--primary)"
        errorColor="var(--destructive)"
      />
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">{state.title}</div>
        <div className="text-sm text-muted-foreground">{state.detail}</div>
      </div>
    </div>
  );
}
