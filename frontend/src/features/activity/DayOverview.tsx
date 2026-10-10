import { useMemo } from "react";
import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { appColor, IDLE_APP } from "./appColor";
import type { DayStats } from "./dayStats";
import { formatDuration, type Session } from "./sessionAggregator";
import { fmtTime, formatTimeRange } from "./sessionTimeline";

const HOUR_MS = 3_600_000;

function midnightsBetween(start: number, end: number): number[] {
  const out: number[] = [];
  const d = new Date(start);
  d.setHours(24, 0, 0, 0);
  for (; d.getTime() < end; d.setDate(d.getDate() + 1)) out.push(d.getTime());
  return out;
}

/**
 * The loaded history at a glance: a coloured strip of every session across the hours worked, alert ticks,
 * and the apps that took the most time. Clicking a segment jumps to that session in the list.
 */
export function TimelineOverview({
  sessions,
  stats,
  focusedId,
  appFilterExe,
  onSelect,
  onFilterApp,
}: {
  sessions: Session[];
  stats: DayStats;
  focusedId: string | null;
  appFilterExe: string | null;
  onSelect: (id: string) => void;
  onFilterApp: (exe: string) => void;
}) {
  const range = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of sessions) {
      min = Math.min(min, s.startTime.getTime());
      max = Math.max(max, s.endTime.getTime());
    }
    const start = Math.floor(min / HOUR_MS) * HOUR_MS;
    const end = Math.max(Math.ceil(max / HOUR_MS) * HOUR_MS, start + HOUR_MS);
    return { start, end, span: end - start };
  }, [sessions]);

  // Under ~1.5 days label hours; beyond that label each midnight so a long history stays readable.
  const hours = Math.round(range.span / HOUR_MS);
  const byDay = hours > 36;
  const step = hours > 16 ? 4 : hours > 8 ? 2 : 1;
  const ticks = byDay
    ? midnightsBetween(range.start, range.end)
    : Array.from({ length: Math.floor(hours / step) + 1 }, (_, i) => range.start + i * step * HOUR_MS);
  const tickLabel = (t: number) =>
    byDay ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric" }) : fmtTime(new Date(t));

  const pct = (ms: number) => ((ms - range.start) / range.span) * 100;
  const topApps = stats.apps.slice(0, 6);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="relative h-9 overflow-hidden rounded-md bg-muted/40">
          {sessions.map((s) => {
            const idle = s.appName === IDLE_APP;
            const left = pct(s.startTime.getTime());
            const width = Math.max(pct(s.endTime.getTime()) - left, 0.35);
            const dimmed = appFilterExe != null && !idle && s.appName.toLowerCase() !== appFilterExe.toLowerCase();
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s.id)}
                title={`${idle ? "Idle" : s.appDisplayName || s.appName} · ${formatTimeRange(s.startTime, s.endTime)} · ${formatDuration(s.duration)}`}
                aria-label={`${idle ? "Idle" : s.appDisplayName || s.appName}, ${fmtTime(s.startTime)}`}
                style={{ left: `${left}%`, width: `${width}%`, background: idle ? undefined : appColor(s.appName) }}
                className={cn(
                  "absolute inset-y-0 cursor-pointer transition-opacity hover:brightness-125 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-foreground",
                  idle && "bg-muted-foreground/15",
                  dimmed && "opacity-20",
                  focusedId === s.id && "z-10 ring-2 ring-foreground ring-inset",
                )}
              />
            );
          })}
        </div>
        <div className="relative h-5">
          {ticks.map((t) => (
            <span
              key={t}
              style={{ left: `${pct(t)}%` }}
              className="absolute top-1 -translate-x-1/2 tabular-nums text-[10.5px] text-muted-foreground/70 first:translate-x-0 last:-translate-x-full"
            >
              {tickLabel(t)}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {topApps.map((app) => {
          const active = appFilterExe?.toLowerCase() === app.exe.toLowerCase();
          return (
            <button
              key={app.exe}
              type="button"
              onClick={() => onFilterApp(app.exe)}
              aria-pressed={active}
              title={active ? "Clear app filter" : `Show only ${app.name}`}
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12.5px] transition-colors hover:bg-muted",
                active && "bg-muted",
              )}
            >
              <span className="size-2.5 rounded-[3px]" style={{ background: appColor(app.exe) }} aria-hidden />
              <span className="font-medium">{app.name}</span>
              <span className="tabular-nums text-[11.5px] text-muted-foreground">{formatDuration(app.secs)}</span>
            </button>
          );
        })}
        {stats.apps.length > topApps.length && (
          <span className="px-2 text-xs text-muted-foreground">+{stats.apps.length - topApps.length} more</span>
        )}
        {stats.alerts > 0 && (
          <span className="ml-auto inline-flex items-center gap-1.5 px-2 text-xs text-destructive">
            <Bell size={12} aria-hidden /> {stats.alerts} alert{stats.alerts === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}
