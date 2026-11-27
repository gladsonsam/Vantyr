import type { ReactNode } from "react";
import { Link2 } from "lucide-react";
import { useHref } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useDnsManagement, useDnsStatus } from "@/api/queries/dnsManagement";
import { networkQueries } from "@/api/queries/network";
import type {
  DnsDeliveryView,
  DnsDownloadState,
  DnsGatewayStatus,
  DnsSourceStatus,
} from "@/api/types";
import { CopyTextButton } from "@/components/common/CopyTextButton";
import { HelpTip } from "@/components/common/HelpTip";
import { QueryError } from "@/features/network/components/QueryError";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { cn } from "@/lib/utils";

const DOWNLOAD: Record<DnsDownloadState, { text: string; label: string }> = {
  never_fetched: { text: "text-muted-foreground", label: "Never fetched" },
  fresh: { text: "text-success", label: "Fresh" },
  stale: { text: "text-warning", label: "Stale" },
  disabled: { text: "text-muted-foreground", label: "Disabled" },
  failed_with_last_good: { text: "text-warning", label: "Failed, using last good copy" },
  unavailable: { text: "text-destructive", label: "Unavailable" },
  quarantined: { text: "text-destructive", label: "Quarantined" },
};

function Dot({ className }: { className: string }) {
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full bg-current", className)}
      aria-hidden="true"
    />
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function LifecycleRow({
  tone,
  title,
  children,
}: {
  tone: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className={cn("mt-1.5 flex", tone)}>
        <Dot className="" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        {children ? <div className="text-[0.8125rem] text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

function Fact({ label, iso }: { label: string; iso: string | null }) {
  return (
    <span>
      {label} {iso ? <TimeAgo iso={iso} /> : "never"}
    </span>
  );
}

function SourceRow({ source, title }: { source: DnsSourceStatus; title?: string }) {
  const state = DOWNLOAD[source.download] ?? {
    text: "text-muted-foreground",
    label: source.download,
  };
  return (
    <li className="space-y-1 px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-sm">
          <span className="font-medium">{source.id}</span>
          {title ? <span className="text-muted-foreground"> · {title}</span> : null}
        </div>
        <span className={cn("flex items-center gap-1.5 text-sm font-medium", state.text)}>
          <Dot className="" />
          {state.label}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[0.8125rem] text-muted-foreground">
        <span>
          {source.rule_count === null
            ? "Rules unknown"
            : `${source.rule_count.toLocaleString()} rules`}
        </span>
        <span>{formatBytes(source.bytes)}</span>
        <Fact label="Checked" iso={source.checked_at} />
        <Fact label="Fetched" iso={source.fetched_at} />
        <Fact label="Content changed" iso={source.content_changed_at} />
        <Fact label="Next due" iso={source.next_due_at} />
      </div>
      {source.failure_count > 0 || source.cooldown_until || source.last_error ? (
        <div className="text-[0.8125rem] text-muted-foreground">
          {source.failure_count > 0 ? <span>{source.failure_count} failures</span> : null}
          {source.cooldown_until ? (
            <span>
              {source.failure_count > 0 ? " · " : ""}cooldown until{" "}
              <TimeAgo iso={source.cooldown_until} />
            </span>
          ) : null}
          {source.last_error ? (
            <span className="block break-words text-warning">Last error: {source.last_error}</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function GatewayStatusCard({
  gateway,
  label,
  desired,
  delivery,
  titles,
}: {
  gateway: DnsGatewayStatus;
  label: string | null;
  desired: number | null;
  delivery: DnsDeliveryView | undefined;
  titles: Map<string, string>;
}) {
  const status = gateway.status;
  const deliveredVersion = delivery?.delivered_version ?? gateway.delivered_version ?? null;
  const deliveredAt = delivery?.delivered_at ?? null;
  const applied = status?.applied ?? null;
  const behind = applied !== null && desired !== null && applied.config_version < desired;
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card/10">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/50 px-5 py-3">
        <h3 className="text-sm font-medium">{label ?? gateway.gateway_id}</h3>
        {label ? (
          <span className="font-mono text-xs text-muted-foreground">{gateway.gateway_id}</span>
        ) : null}
      </header>
      <div className="space-y-4 px-5 py-4">
        <div className="space-y-3">
          <LifecycleRow
            tone={desired === null ? "text-muted-foreground" : "text-primary"}
            title={desired === null ? "Desired: nothing saved" : `Desired v${desired}`}
          />
          <LifecycleRow
            tone={deliveredVersion === null ? "text-muted-foreground" : "text-primary"}
            title={
              deliveredVersion === null ? "Not delivered yet" : `Delivered v${deliveredVersion}`
            }
          >
            {deliveredAt ? <TimeAgo iso={deliveredAt} /> : null}
          </LifecycleRow>
          {status === null ? (
            <LifecycleRow tone="text-muted-foreground" title="No report yet">
              {deliveredVersion === null
                ? "This gateway has not sent a DNS management report."
                : "The worker fetched its configuration but has not sent a status report yet."}
            </LifecycleRow>
          ) : (
            <LifecycleRow
              tone={
                applied === null
                  ? "text-muted-foreground"
                  : behind
                    ? "text-warning"
                    : "text-primary"
              }
              title={
                applied === null ? (
                  "Never applied"
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    Worker reports applied management v{applied.config_version}
                    <HelpTip label="Technical details">
                      <dl className="space-y-1 text-xs">
                        <div>Generation {applied.generation}</div>
                        <div>Filter generation {applied.filter_generation}</div>
                        <div className="break-all">Filter identity {applied.filter_identity}</div>
                        <div className="break-all font-mono">Config hash {applied.body_sha256}</div>
                      </dl>
                    </HelpTip>
                  </span>
                )
              }
            >
              {applied === null ? (
                "The worker has not reported applying a configuration."
              ) : (
                <>
                  {applied.applied_at ? (
                    <>
                      Applied <TimeAgo iso={applied.applied_at} />
                    </>
                  ) : (
                    "Apply time not reported"
                  )}
                  {behind ? (
                    <span className="block">
                      Gateway is on an older configuration than desired.
                    </span>
                  ) : null}
                </>
              )}
            </LifecycleRow>
          )}
        </div>
        {status !== null ? (
          <p className="text-[0.8125rem] text-muted-foreground">
            Reported v{status.config_version} received <TimeAgo iso={status.received_at} />
          </p>
        ) : null}
        {applied?.last_error ? (
          <p className="break-words text-[0.8125rem] text-warning">
            Apply error: {applied.last_error}
          </p>
        ) : null}
      </div>
      {status && status.sources.length > 0 ? (
        <ul className="divide-y divide-border/50 border-t border-border/50">
          {status.sources.map((source) => (
            <SourceRow key={source.id} source={source} title={titles.get(source.id)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * What DNS workers last reported. Delivery is not application, and a report is the worker's own
 * statement: it is never shown as verified or enforced. Works with `network_events` alone
 * (`canManage` adds delivery context, gateway labels and the status link, all admin-only reads).
 */
export function DnsStatusPanel({
  householdId,
  canManage,
}: {
  householdId: string;
  canManage?: boolean;
}) {
  const status = useDnsStatus(householdId);
  const management = useDnsManagement(householdId, { enabled: !!canManage });
  const gateways = useQuery({ ...networkQueries.gateways(householdId), enabled: !!canManage });
  const href = useHref(`/network/dns-status/${householdId}`);
  const link = new URL(href, window.location.origin).href;

  if (status.isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (status.isError) {
    return (
      <QueryError
        title="DNS status"
        error={status.error}
        scope="network_events"
        onRetry={() => void status.refetch()}
      />
    );
  }

  const labels = new Map((gateways.data?.gateways ?? []).map((g) => [g.id, g.label]));
  const delivery = new Map<string, DnsDeliveryView>(
    (management.data?.delivery ?? []).map((d) => [d.gateway_id, d]),
  );
  const titles = new Map(
    (management.data?.desired?.config.sources ?? []).map((s) => [s.id, s.metadata.title]),
  );
  const view = status.data;
  // A worker can fetch its config (delivery known) before its first status report.
  const known = new Set(view.gateways.map((g) => g.gateway_id));
  const gatewaysShown: DnsGatewayStatus[] = [
    ...view.gateways,
    ...[...delivery.values()]
      .filter((d) => !known.has(d.gateway_id))
      .map((d): DnsGatewayStatus => ({
        gateway_id: d.gateway_id,
        delivered_version: d.delivered_version ?? null,
        reported_version: d.reported_version ?? null,
        status: null,
      })),
  ];

  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex justify-end">
          <CopyTextButton text={link} label="Copy status link" />
        </div>
      ) : null}
      {gatewaysShown.length === 0 ? (
        <p className="rounded-xl border border-border/70 bg-card/10 px-5 py-4 text-sm text-muted-foreground">
          No gateway has fetched or reported DNS management yet. Reports need a worker credential
          with the DNS report scope and the worker running with --dns-management.
        </p>
      ) : (
        gatewaysShown.map((gateway) => (
          <GatewayStatusCard
            key={gateway.gateway_id}
            gateway={gateway}
            label={labels.get(gateway.gateway_id) ?? null}
            desired={view.desired_version}
            delivery={delivery.get(gateway.gateway_id)}
            titles={titles}
          />
        ))
      )}
      <p className="flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden="true" />
        Management reports are not heartbeats; a missing heartbeat does not make a recent report
        offline.
      </p>
    </div>
  );
}
