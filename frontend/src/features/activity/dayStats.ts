import { IDLE_APP } from "./appColor";
import type { Session } from "./sessionAggregator";

export type DayStats = {
  activeSecs: number;
  idleSecs: number;
  alerts: number;
  keystrokes: number;
  apps: { exe: string; name: string; secs: number }[];
};

export function computeDayStats(sessions: Session[]): DayStats {
  let activeSecs = 0;
  let idleSecs = 0;
  let alerts = 0;
  let keystrokes = 0;
  const byApp = new Map<string, { exe: string; name: string; secs: number }>();
  for (const s of sessions) {
    alerts += s.alertEvents?.length ?? 0;
    keystrokes += s.keystrokeCount;
    if (s.appName === IDLE_APP) {
      idleSecs += s.duration;
      continue;
    }
    activeSecs += s.duration;
    const key = s.appName.toLowerCase();
    const prev = byApp.get(key);
    if (prev) prev.secs += s.duration;
    else byApp.set(key, { exe: s.appName, name: s.appDisplayName || s.appName, secs: s.duration });
  }
  const apps = [...byApp.values()].sort((a, b) => b.secs - a.secs);
  return { activeSecs, idleSecs, alerts, keystrokes, apps };
}
