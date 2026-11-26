import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, AgentInfo, AgentLiveStatus, AgentMetricsResponse } from "@/api/types";
import { agentQueries } from "@/api/queries/agents";
import { ruleQueries } from "@/api/queries/rules";
import { primaryIp } from "@/features/fleet/lib/agentNetwork";
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
  /** 0–100: draws a thin usage bar under the value. */
  pct?: number;
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
          },
          {
            label: "Session",
            value: activity === "afk" ? "Away" : "Active",
            tone: activity === "afk" ? "text-warning" : "text-success",
          },
        ]
      : []),
    { label: "Memory", value: mem.text, tone: "text-foreground", pct: mem.pct },
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

  return (
    <dl
      aria-label="Device summary"
      style={{ "--vital-count": vitals.length } as CSSProperties}
      className={cn(
        "m-0 grid grid-cols-2 gap-x-5 gap-y-1.5 rounded-xl bg-card px-4 py-3 sm:gap-y-3 sm:py-3.5 sm:grid-cols-3 md:grid-cols-4 md:px-5 xl:grid-cols-[repeat(var(--vital-count),minmax(0,1fr))]",
        className,
      )}
    >
      {vitals.map((vital) => (
        <div
          key={vital.label}
          className="flex min-w-0 items-baseline justify-between gap-2 sm:block"
        >
          <dt className="shrink-0 text-[11px] font-medium text-muted-foreground">{vital.label}</dt>
          <dd
            className={cn(
              "m-0 min-w-0 truncate text-right text-[13px] font-semibold tabular-nums sm:mt-0.5 sm:text-left",
              vital.mono && "font-mono",
              vital.tone,
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
          {vital.pct != null && (
            <div
              aria-hidden="true"
              className="mt-1.5 hidden h-[3px] overflow-hidden rounded-full bg-foreground/10 sm:block"
            >
              <div
                className="h-full rounded-full bg-primary/80"
                style={{ width: `${vital.pct}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </dl>
  );
}
