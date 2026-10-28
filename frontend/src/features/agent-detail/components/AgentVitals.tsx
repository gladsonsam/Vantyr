import { useQuery } from "@tanstack/react-query";
import type { Agent, AgentInfo, AgentLiveStatus, AgentMetricsResponse } from "@/api/types";
import { agentQueries } from "@/api/queries/agents";
import { ruleQueries } from "@/api/queries/rules";
import { primaryIp } from "@/features/fleet/lib/agentNetwork";
import { Gauge } from "@/components/common/Metrics";
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

function latestCpuPct(res: AgentMetricsResponse): number | null {
  const pts = res.points ?? [];
  const latest = pts.length ? pts[pts.length - 1] : null;
  return latest ? Math.round(latest.cpu_pct) : null;
}

function memoryParts(info: AgentInfo | null) {
  const total = info?.memory_total_mb;
  const used = info?.memory_used_mb;
  if (!total) return { pct: 0, text: "—" };
  const pct = used ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const usedGb = used ? Math.round(used / 1024) : 0;
  const totalGb = Math.round(total / 1024);
  return { pct, text: `${usedGb} / ${totalGb} GB` };
}

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
  const internetQuery = useQuery({ ...ruleQueries.internetBlocked(agent.id), select: (res) => Boolean(res.blocked) });
  const internetBlocked = internetQuery.data ?? null;

  // Live CPU load isn't part of the system-info snapshot — pull the most recent
  // sample from the metrics time-series (same source the resource history chart uses).
  const cpuQuery = useQuery({ ...agentQueries.metrics(agent.id, 1), enabled: online, select: latestCpuPct });
  const cpuPct = online ? cpuQuery.data ?? null : null;

  const mem = memoryParts(info);
  const activity = liveStatus?.activity;
  const sessionLabel = activity === "afk" ? "Away" : "Active";

  const rows: Array<{ label: string; value: string; tone: string; compactOnly?: boolean }> = [
    // The gauge carries CPU on wide screens; phones get it as a plain row instead.
    ...(online
      ? [
          { label: "CPU", value: cpuPct != null ? `${cpuPct}%` : "—", tone: "text-foreground", compactOnly: true },
          { label: "Session", value: sessionLabel, tone: activity === "afk" ? "text-warning" : "text-success" },
        ]
      : []),
    { label: online ? "Uptime" : "Last seen", value: online ? uptimeText : lastSeenText, tone: "text-foreground" },
    { label: "Memory", value: mem.text, tone: "text-foreground" },
    { label: "Version", value: `v${version}`, tone: updateAvailable ? "text-warning" : "text-foreground" },
    { label: "IP address", value: primaryIp(info) ?? "—", tone: "text-foreground" },
    {
      label: "Internet",
      value: internetBlocked == null ? "—" : internetBlocked ? "Blocked" : "Allowed",
      tone: internetBlocked ? "text-destructive" : internetBlocked === false ? "text-success" : "text-muted-foreground",
    },
  ];

  return (
    <div className={cn("flex flex-col rounded-xl bg-card px-5 py-3", online && "lg:p-5", className)}>
      {/* Gauge + headline metric (wide screens only; phones keep the page short) */}
      <div className={cn("hidden items-center gap-4 border-b border-foreground/[0.06] pb-4", online && "lg:flex")}>
        {online ? (
          <Gauge value={cpuPct ?? 0} size={86} color="var(--success)" label="CPU" big />
        ) : (
          <div className="flex size-[86px] shrink-0 items-center justify-center rounded-full border-[5px] border-muted">
            <span className="text-xs font-semibold text-muted-foreground">OFF</span>
          </div>
        )}
        <div className="min-w-0">
          <div className="mb-1 text-xs font-semibold text-muted-foreground">CPU load</div>
          <div className="font-heading text-[15px] font-bold tracking-tight text-foreground">
            {info?.cpu_cores ? `${info.cpu_cores} cores` : "—"}
          </div>
          {info?.cpu_brand && (
            <div
              className="mt-1 max-w-44 truncate text-[11px] text-muted-foreground"
              title={info.cpu_brand}
            >
              {info.cpu_brand}
            </div>
          )}
        </div>
      </div>

      {/* Vitals rows */}
      <div className={cn("grid grid-cols-2 gap-x-6", online ? "lg:flex lg:flex-col lg:pt-1.5" : "md:grid-cols-3 lg:grid-cols-5")}>
        {rows.map((row) => (
          <div
            key={row.label}
            className={cn(
              "flex min-w-0 items-center justify-between gap-3 py-1.5",
              online && "lg:border-b lg:border-foreground/[0.05] lg:py-2.5 lg:last:border-0",
              row.compactOnly && "lg:hidden",
            )}
          >
            <span className="shrink-0 text-xs font-medium text-muted-foreground">{row.label}</span>
            <span
              className={cn("truncate text-right text-xs font-semibold tabular-nums", row.label === "IP address" && "font-mono", row.tone)}
              title={row.value}
            >{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
