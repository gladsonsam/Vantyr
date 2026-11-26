import { useQuery } from "@tanstack/react-query";
import { agentQueries } from "@/api/queries/agents";
import { useAgents } from "@/app/providers/useAgents";
import { StatCard } from "@/components/common/StatCard";
import { useResolvedAgentInfo } from "@/features/agent-detail/useResolvedAgentInfo";
import { primaryIp } from "@/features/fleet/lib/agentNetwork";
import {
  agentVersion,
  formatUptime,
  statusFor,
} from "@/features/agent-detail/lib/agentStatus";
import { OverviewCard } from "./OverviewCard";

const pct = (value: number | undefined) => (value == null ? "—" : `${Math.round(value)}%`);

/** CPU, memory and disk over the last day, from the same samples the agent's resource history charts. */
export function OverviewAgentStats({ agentId }: { agentId: string }) {
  const metrics = useQuery(agentQueries.metrics(agentId, 24));
  const points = metrics.data?.points ?? [];
  const latest = points.length > 0 ? points[points.length - 1] : undefined;
  if (metrics.isPending) return <div className="h-40" />;
  const gb = (value: number | undefined, digits = 0) =>
    value == null ? undefined : value.toFixed(digits);
  return (
    <div className="grid grid-cols-2 gap-5 lg:grid-cols-3">
      <StatCard
        label="CPU"
        value={pct(latest?.cpu_pct)}
        trend={points.map((p) => p.cpu_pct)}
        trendMax={100}
        hue="text-metric-cpu"
      />
      <StatCard
        label="Memory"
        value={pct(latest?.mem_pct)}
        delta={
          latest
            ? `${gb(latest.mem_used_mb / 1024, 1)} / ${gb(latest.mem_total_mb / 1024, 1)} GB`
            : undefined
        }
        trend={points.map((p) => p.mem_pct)}
        trendMax={100}
        hue="text-metric-memory"
      />
      <StatCard
        label="Disk"
        value={pct(latest?.disk_pct)}
        delta={latest ? `${gb(latest.disk_used_gb)} / ${gb(latest.disk_total_gb)} GB` : undefined}
        trend={points.map((p) => p.disk_pct)}
        trendMax={100}
        hue="text-metric-disk"
      />
    </div>
  );
}

/** What the agent is doing now, how long it has been up, which build it runs and where it sits on the network. */
export function OverviewAgentFacts({ agentId }: { agentId: string }) {
  const { agents, agentInfo, liveStatus } = useAgents();
  const agent = agents[agentId];
  const { resolvedInfo } = useResolvedAgentInfo(agentId, agentInfo[agentId] ?? null);
  if (!agent) return null;
  const status = statusFor(agent, liveStatus[agentId]);
  const facts: { label: string; value: string; mono?: boolean }[] = [
    { label: "Now", value: status.label },
    ...(agent.online ? [{ label: "Uptime", value: formatUptime(resolvedInfo?.uptime_secs) }] : []),
    { label: "Version", value: `v${agentVersion(resolvedInfo, agent)}` },
    { label: "IP", value: primaryIp(resolvedInfo) ?? "—", mono: true },
  ];
  return (
    <OverviewCard title="This computer">
      <dl className="m-0 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {facts.map((fact) => (
          <div key={fact.label} className="min-w-0 rounded-lg bg-muted/30 p-5">
            <dt className="text-sm text-muted-foreground">{fact.label}</dt>
            <dd
              className={
                fact.mono
                  ? "m-0 mt-1 truncate font-mono text-base font-semibold tabular-nums"
                  : "m-0 mt-1 truncate text-base font-semibold tabular-nums"
              }
              title={fact.value}
            >
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </OverviewCard>
  );
}
