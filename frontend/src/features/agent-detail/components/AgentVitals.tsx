import { useQuery } from "@tanstack/react-query";
import type { Agent, AgentInfo, AgentLiveStatus, AgentMetricsResponse } from "@/api/types";
import { agentQueries } from "@/api/queries/agents";
import { ruleQueries } from "@/api/queries/rules";
import { primaryIp } from "@/features/fleet/lib/agentNetwork";
import { MetricRing } from "@/components/common/MetricRing";
import { cn } from "@/lib/utils";

interface AgentVitalsProps {
  agent: Agent;
  info: AgentInfo | null;
  liveStatus?: AgentLiveStatus;
  uptimeText: string;
  lastSeenText: string;
  version: string;
  updateAvailable?: boolean;
  className?: string;
}

interface Vital {
  label: string;
  value: string;
  tone: string;
  mono?: boolean;
  /** Shown only from `sm` up (keeps the phone rows short). */
  extra?: string;
  /** 0–100: draws a ring gauge beside the value. */
  pct?: number;
  ring?: "cpu" | "memory";
  /** Status fact: shown first, with a coloured dot. */
  dot?: boolean;
}

function latestCpuPct(res: AgentMetricsResponse): number | null {
  const pts = res.points ?? [];
  const latest = pts.length ? pts[pts.length - 1] : null;
  return latest ? Math.round(latest.cpu_pct) : null;
}

function memoryParts(info: AgentInfo | null) {
  const total = info?.memory_total_mb;
  const used = info?.memory_used_mb;
  if (!total) return { pct: undefined, text: "—" };
  const pct = used ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const usedGb = used ? Math.round(used / 1024) : 0;
  const totalGb = Math.round(total / 1024);
  return { pct, text: `${usedGb} / ${totalGb} GB` };
}

function vitalList(
  {
    agent,
    info,
    liveStatus,
    uptimeText,
    lastSeenText,
    version,
    updateAvailable,
  }: Pick<
    AgentVitalsProps,
    "agent" | "info" | "liveStatus" | "uptimeText" | "lastSeenText" | "version" | "updateAvailable"
  >,
  cpuPct: number | null,
  internetBlocked: boolean | null,
): Vital[] {
  const online = agent.online;
  const mem = memoryParts(info);
  const activity = liveStatus?.activity;
  const cores = info?.cpu_cores ? `${info.cpu_cores} cores` : undefined;

  return [
    ...(online
      ? [
          {
            label: "CPU",
            value: cpuPct != null ? `${cpuPct}%` : "—",
            extra: cores,
            tone: "text-foreground",
            pct: cpuPct ?? undefined,
            ring: "cpu" as const,
          },
          {
            label: "Session",
            value: activity === "afk" ? "Away" : "Active",
            tone: activity === "afk" ? "text-warning" : "text-success",
            dot: true,
          },
        ]
      : []),
    {
      label: "Memory",
      value: mem.text,
      tone: "text-foreground",
      pct: mem.pct,
      ring: "memory" as const,
    },
    {
      label: online ? "Uptime" : "Last seen",
      value: online ? uptimeText : lastSeenText,
      tone: "text-foreground",
    },
    { label: "IP", value: primaryIp(info) ?? "—", tone: "text-foreground", mono: true },
    {
      label: "Version",
      value: `v${version}`,
      tone: updateAvailable ? "text-warning" : "text-foreground",
    },
    {
      label: "Internet",
      value: internetBlocked == null ? "—" : internetBlocked ? "Blocked" : "Allowed",
      tone: internetBlocked
        ? "text-destructive"
        : internetBlocked === false
          ? "text-success"
          : "text-muted-foreground",
      dot: true,
    },
  ];
}

/**
 * A slim strip of device facts under the live screen. Facts live in a flowing grid so the desktop
 * keeps the full page width and the strip wraps to two or three short rows on narrow screens.
 */
export function AgentVitals({
  agent,
  info,
  liveStatus,
  uptimeText,
  lastSeenText,
  version,
  updateAvailable = false,
  className,
}: AgentVitalsProps) {
  const online = agent.online;
  const internetQuery = useQuery({
    ...ruleQueries.internetBlocked(agent.id),
    select: (res) => Boolean(res.blocked),
  });
  const internetBlocked = internetQuery.data ?? null;

  // Live CPU load isn't part of the system-info snapshot — pull the most recent
  // sample from the metrics time-series (same source the resource history chart uses).
  const cpuQuery = useQuery({
    ...agentQueries.metrics(agent.id, 1),
    enabled: online,
    select: latestCpuPct,
  });
  const cpuPct = online ? (cpuQuery.data ?? null) : null;

  const vitals = vitalList(
    { agent, info, liveStatus, uptimeText, lastSeenText, version, updateAvailable },
    cpuPct,
    internetBlocked,
  );

  const renderVital = (vital: Vital) => (
    <div
      key={vital.label}
      className="flex min-w-0 items-center gap-2.5 px-4 py-2.5 not-first:border-l not-first:border-border/60 max-sm:not-first:border-l-0"
    >
      {vital.pct != null && vital.ring ? (
        <MetricRing percent={vital.pct} variant={vital.ring} size={26} stroke={3.5} />
      ) : vital.dot ? (
        <span
          className={cn("size-2 shrink-0 rounded-full bg-current", vital.tone)}
          aria-hidden="true"
        />
      ) : null}
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{vital.label}</dt>
        <dd
          className={cn(
            "m-0 min-w-0 truncate text-sm font-medium tabular-nums",
            vital.tone,
            vital.mono && "font-mono",
          )}
          title={vital.extra ? `${vital.value} · ${vital.extra}` : vital.value}
        >
          {vital.value}
          {vital.extra && (
            <span className="hidden font-normal text-muted-foreground sm:inline">
              {" "}
              · {vital.extra}
            </span>
          )}
        </dd>
      </div>
    </div>
  );

  return (
    <dl
      aria-label="Device summary"
      className={cn(
        "m-0 flex flex-wrap items-stretch rounded-xl border border-border/70 bg-card/10",
        className,
      )}
    >
      {vitals.map(renderVital)}
    </dl>
  );
}
