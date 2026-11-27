import { useMemo } from "react";
import { Link } from "react-router-dom";
import { AppWindow, ArrowUpRight } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { useAgents } from "@/app/providers/useAgents";
import { useSession } from "@/app/providers/useSession";
import { AppIcon } from "@/components/common/AppIcon";
import { StatCard } from "@/components/common/StatCard";
import { useResolvedAgentInfo } from "@/features/agent-detail/useResolvedAgentInfo";
import { formatLastSeen, statusFor, statusTone } from "@/features/agent-detail/lib/agentStatus";
import { appColor, IDLE_APP } from "@/features/activity/appColor";
import { computeDayStats } from "@/features/activity/dayStats";
import { formatDuration, type Session } from "@/features/activity/sessionAggregator";
import { useAgentActivitySessions } from "@/features/activity/useAgentActivitySessions";
import { LiveScreenPreview } from "@/features/remote/components/LiveScreenPreview";
import { prettyAppLabel } from "@/lib/appNames";
import { OverviewCard } from "./OverviewCard";
import { OverviewDnsStats } from "./OverviewStats";

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Sessions that ran today, cut at midnight so a session that started last night only counts from 00:00. */
function todaysSessions(sessions: Session[]): Session[] {
  const midnight = startOfToday();
  return sessions
    .filter((s) => s.endTime >= midnight)
    .map((s) =>
      s.startTime >= midnight
        ? s
        : {
            ...s,
            startTime: midnight,
            duration: Math.round((s.endTime.getTime() - midnight.getTime()) / 1000),
          },
    );
}

/** Per-hour totals from midnight to now, for the sparklines. */
function hourly(sessions: Session[], pick: (s: Session) => number): number[] {
  const hours = new Date().getHours() + 1;
  const buckets = Array.from({ length: Math.max(hours, 2) }, () => 0);
  const midnight = startOfToday().getTime();
  for (const s of sessions) {
    const hour = Math.min(
      buckets.length - 1,
      Math.floor((s.startTime.getTime() - midnight) / 3_600_000),
    );
    if (hour >= 0) buckets[hour] += pick(s);
  }
  return buckets;
}

/** The title line of the current window: drops a trailing " - App" suffix the app name already says. */
function windowTitle(window: string | undefined, app: string): string {
  if (!window) return "";
  const parts = window.split(" - ");
  if (parts.length > 1 && parts[parts.length - 1].trim().toLowerCase() === app.toLowerCase()) {
    return parts.slice(0, -1).join(" - ").trim();
  }
  return window;
}

/**
 * An agent device's Overview top: its live screen beside what is happening on it, then the
 * monitoring figures (activity, alerts, and this device's DNS when it has any).
 */
export function OverviewAgent({
  agentId,
  base,
  dnsDeviceId,
}: {
  agentId: string;
  base: string;
  /** Set when the device also has DNS data, so its figures join the same row. */
  dnsDeviceId: string | null;
}) {
  const { user } = useSession();
  const { agents, agentInfo, liveStatus } = useAgents();
  const agent = agents[agentId];
  const live = liveStatus[agentId];
  const { resolvedInfo } = useResolvedAgentInfo(agentId, agentInfo[agentId] ?? null);
  const { sessions } = useAgentActivitySessions(agentId, "live");
  const today = useMemo(() => todaysSessions(sessions), [sessions]);
  const stats = useMemo(() => computeDayStats(today), [today]);
  if (!agent) return null;

  const online = agent.online;
  const status = statusFor(agent, live);
  const tone = statusTone(status.status);
  const exe = live?.app;
  const app = exe ? prettyAppLabel({ exeName: exe }) : "";
  const title = windowTitle(live?.window, app);
  const liveHref = `${base}/agent?tab=live`;

  // Time on the current app: the newest session, while it is still the app in focus.
  const latest = today.reduce<Session | null>(
    (best, s) => (!best || s.endTime > best.endTime ? s : best),
    null,
  );
  const onApp =
    online && latest && live?.app && latest.appName.toLowerCase() === live.app.toLowerCase()
      ? latest.duration
      : null;
  const stateLabel =
    status.status === "afk"
      ? (live?.idleSecs ?? 0) >= 600
        ? "Away"
        : "Idle"
      : status.status === "offline"
        ? "Offline"
        : "Active";
  const topApps = stats.apps.filter((a) => a.secs >= 60).slice(0, 4);
  const maxSecs = topApps[0]?.secs ?? 1;

  const cards = [
    <StatCard
      key="active"
      label="Active time today"
      value={stats.activeSecs > 0 ? formatDuration(Math.round(stats.activeSecs)) : "0m"}
      trend={hourly(today, (s) => (s.appName === IDLE_APP ? 0 : s.duration))}
      hue="text-primary"
    />,
    <Link key="alerts" to={`${base}/agent?tab=alerts`} className="block min-w-0">
      <StatCard
        label="Alerts today"
        value={stats.alerts}
        trend={hourly(today, (s) => s.alertEvents?.length ?? 0)}
        hue={stats.alerts > 0 ? "text-destructive" : "text-info"}
      />
    </Link>,
  ];

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-5">
        <OverviewCard
          title="Live screen"
          className="lg:col-span-3"
          action={
            <div className="flex items-center gap-4">
              <span
                className={`flex items-center gap-2 text-sm font-medium ${online ? "text-success" : "text-muted-foreground"}`}
              >
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full"
                  style={{ background: online ? "var(--success)" : "var(--muted-foreground)" }}
                />
                {online ? "Live" : "Offline"}
              </span>
              <Button size="sm" nativeButton={false} render={<Link to={liveHref} />}>
                Open live view
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          }
        >
          <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border/70 bg-[#0a0b0d]">
            <LiveScreenPreview
              agentId={agentId}
              online={online}
              agentInfo={resolvedInfo}
              dashboardRole={user?.role ?? null}
              offline={`Offline · last seen ${formatLastSeen(agent.last_seen)}`}
            />
            {online && (app || title) ? (
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-black/70 px-4 py-2 text-sm text-white">
                <span className="shrink-0 font-medium">{app}</span>
                {title ? <span className="min-w-0 truncate text-white/70">{title}</span> : null}
              </div>
            ) : null}
          </div>
        </OverviewCard>

        <OverviewCard title="Activity now" className="lg:col-span-2">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted/40">
              <AppIcon
                agentId={agentId}
                exeName={exe}
                size={28}
                fallback={<AppWindow className="size-6 text-muted-foreground" aria-hidden="true" />}
              />
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold">
                {app || (online ? "Nothing reported yet" : "No recent activity")}
              </div>
              <div className="truncate text-sm text-muted-foreground" title={live?.window}>
                {title || (live?.window ? live.window : "No window title")}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className={`flex items-center gap-2 font-medium ${tone.text}`}>
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{ background: tone.dot }}
              />
              {stateLabel}
            </span>
            {onApp !== null ? (
              <span className="text-muted-foreground">{formatDuration(onApp)} on this app</span>
            ) : null}
          </div>
          {topApps.length > 0 ? (
            <div className="space-y-3 border-t border-border/70 pt-5">
              <div className="text-sm font-medium text-muted-foreground">Today</div>
              <ul className="m-0 list-none space-y-3 p-0">
                {topApps.map((a) => (
                  <li key={a.exe} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate">
                        {prettyAppLabel({ exeName: a.exe, appDisplay: a.name })}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatDuration(Math.round(a.secs))}
                      </span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-muted/50">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.max(4, (a.secs / maxSecs) * 100)}%`,
                          background: appColor(a.exe),
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </OverviewCard>
      </div>
      {dnsDeviceId ? (
        <OverviewDnsStats deviceId={dnsDeviceId} leading={cards} />
      ) : (
        <div className="grid grid-cols-2 gap-5">{cards}</div>
      )}
    </>
  );
}
