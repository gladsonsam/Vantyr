import { parseTimestamp } from "@/lib/utils";
import type { Session, SessionAlertEvent } from "./sessionAggregator";

// Pure helpers behind the activity timeline: day grouping, merging adjacent sessions, and the
// per-session stream of window / URL / alert rows.

// ── Date/time helpers ─────────────────────────────────────────────────────────

export function fmtTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(date: Date): string {
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Local calendar day key for grouping (YYYY-MM-DD). */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatDayHeading(dayKey: string): string {
  const [y, mo, da] = dayKey.split("-").map(Number);
  const d = new Date(y, mo - 1, da);
  return d.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function sessionMatchesSearch(session: Session, q: string): boolean {
  const n = q.trim().toLowerCase();
  if (!n) return true;
  const parts: string[] = [
    session.appName,
    session.appDisplayName,
    session.windowTitle,
    session.user ?? "",
    ...session.urls.map((u) => `${u.url} ${u.browser}`),
    ...session.windows.map((w) => w.window_title),
    ...session.keystrokes.map((k) => `${k.keys} ${k.window_title}`),
    ...(session.alertEvents ?? []).flatMap((e) => [e.rule_name, e.snippet, e.channel]),
  ];
  return parts.join(" ").toLowerCase().includes(n);
}

export function isLockScreenApp(exeName: string): boolean {
  const n = (exeName ?? "").trim().toLowerCase();
  return n === "lockapp" || n === "lockapp.exe";
}

export type DayGroup = {
  dayKey: string;
  label: string;
  items: { session: Session; idx: number }[];
};

export function groupSessionsByDay(sessions: Session[]): DayGroup[] {
  const map = new Map<string, { session: Session; idx: number }[]>();
  sessions.forEach((session, idx) => {
    const key = dayKey(session.startTime);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({ session, idx });
  });
  const keys = [...map.keys()].sort((a, b) => b.localeCompare(a));
  return keys.map((k) => ({
    dayKey: k,
    label: formatDayHeading(k),
    items: map.get(k)!,
  }));
}

export function formatTimeRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
  const startStr = start.toLocaleTimeString([], opts);
  const endStr = end.toLocaleTimeString([], opts);
  if (!isSameDay(start, end)) {
    return `${fmtDate(start)} ${startStr} – ${fmtDate(end)} ${endStr}`;
  }
  return `${startStr} – ${endStr}`;
}

export function mergeAlertEvents(
  a: Session["alertEvents"] | undefined,
  b: Session["alertEvents"] | undefined,
): Session["alertEvents"] {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length === 0 && bb.length === 0) return undefined;
  const seen = new Set<number>();
  const out: NonNullable<Session["alertEvents"]> = [];
  for (const ev of [...aa, ...bb]) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  out.sort((x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime());
  return out;
}

// ── Merge adjacent sessions of same app ──────────────────────────────────────

export function mergeAdjacentByApp(sessions: Session[]): Session[] {
  const out: Session[] = [];
  for (const s of sessions) {
    const last = out[out.length - 1];
    if (last && last.appName.toLowerCase() === s.appName.toLowerCase()) {
      out[out.length - 1] = {
        ...last,
        windowTitle: s.windowTitle || last.windowTitle,
        startTime: last.startTime < s.startTime ? last.startTime : s.startTime,
        endTime: last.endTime > s.endTime ? last.endTime : s.endTime,
        duration: Math.round(
          (Math.max(last.endTime.getTime(), s.endTime.getTime()) -
            Math.min(last.startTime.getTime(), s.startTime.getTime())) / 1000
        ),
        urls: [...last.urls, ...s.urls],
        keystrokes: [...last.keystrokes, ...s.keystrokes],
        windows: [...last.windows, ...s.windows],
        keystrokeCount: last.keystrokeCount + s.keystrokeCount,
        hasKeystrokes: last.hasKeystrokes || s.hasKeystrokes,
        hasUrls: last.hasUrls || s.hasUrls,
        alertEvents: mergeAlertEvents(last.alertEvents, s.alertEvents),
      };
    } else {
      out.push(s);
    }
  }
  return out;
}

export function dedupeWindowsByTimestampAndTitle(windows: Session["windows"]) {
  const seen = new Set<string>();
  const out: Session["windows"] = [];
  for (const win of windows) {
    const key = `${win.timestamp}::${win.window_title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(win);
  }
  return out;
}

/** Single chronological stream: window focus, URLs, and alert rows (incl. screenshots). */
export type MergedActivityRow =
  | { kind: "window"; time: number; window: Session["windows"][number] }
  | { kind: "url"; time: number; url: Session["urls"][number] }
  | { kind: "page"; time: number; window: Session["windows"][number]; url: Session["urls"][number] }
  | { kind: "alert"; time: number; alert: SessionAlertEvent };

function timeMsFromUnknown(ts: string | undefined): number {
  const d = parseTimestamp(ts);
  return d ? d.getTime() : NaN;
}

function rowStableId(row: MergedActivityRow): number {
  if (row.kind === "window") return row.window.id;
  if (row.kind === "url") return row.url.id;
  if (row.kind === "page") return row.window.id * 1_000_000 + row.url.id;
  return row.alert.id;
}

/**
 * When window + URL share the same instant, treat as one navigation.
 * If several window rows share that instant with one URL, pair the **last** window (closest to URL)
 * with the URL; earlier windows stay as separate rows.
 */
function mergeWindowUrlAtSameInstant(rows: MergedActivityRow[]): MergedActivityRow[] {
  const out: MergedActivityRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const t = rows[i].time;
    let j = i;
    while (j < rows.length && rows[j].time === t) j++;
    const group = rows.slice(i, j);
    const urls = group.filter((r): r is Extract<MergedActivityRow, { kind: "url" }> => r.kind === "url");
    const wins = group.filter((r): r is Extract<MergedActivityRow, { kind: "window" }> => r.kind === "window");

    if (urls.length === 1 && wins.length >= 1) {
      const urlR = urls[0];
      const lastWin = wins[wins.length - 1];
      for (const r of group) {
        if (r.kind === "alert") out.push(r);
      }
      for (const w of wins.slice(0, -1)) {
        out.push(w);
      }
      out.push({
        kind: "page",
        time: t,
        window: lastWin.window,
        url: urlR.url,
      });
      i = j;
      continue;
    }
    for (const r of group) out.push(r);
    i = j;
  }
  return out;
}

/**
 * Windows, URLs, and alerts — **newest first** (matches the activity feed). Uses `parseTimestamp`
 * for sort keys. Same instant: alert → window → URL (inverse of bottom-up causal order), then id desc.
 */
export function buildMergedActivityTimeline(session: Session): MergedActivityRow[] {
  const rows: MergedActivityRow[] = [];
  for (const w of session.windows) {
    if (!(w.window_title ?? "").trim()) continue;
    const t = timeMsFromUnknown(w.timestamp);
    if (!isNaN(t)) rows.push({ kind: "window", time: t, window: w });
  }
  for (const u of session.urls) {
    const t = timeMsFromUnknown(u.timestamp);
    if (!isNaN(t)) rows.push({ kind: "url", time: t, url: u });
  }
  for (const ev of session.alertEvents ?? []) {
    const t = timeMsFromUnknown(ev.created_at);
    if (!isNaN(t)) rows.push({ kind: "alert", time: t, alert: ev });
  }
  rows.sort((a, b) => {
    if (a.time !== b.time) return b.time - a.time;
    const kindOrder: Record<MergedActivityRow["kind"], number> = {
      alert: 0,
      window: 1,
      url: 2,
      page: 1,
    };
    const kd = kindOrder[a.kind] - kindOrder[b.kind];
    if (kd !== 0) return kd;
    return rowStableId(b) - rowStableId(a);
  });
  return mergeWindowUrlAtSameInstant(rows);
}

/** Only http(s) URLs are safe to render as clickable links (blocks `javascript:` click-to-XSS). */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

// ── Feed preparation ─────────────────────────────────────────────────────────

/** Newest-first feed: adjacent same-app sessions merged, duplicate window rows dropped. */
export function prepareTimelineSessions(sessions: Session[]): Session[] {
  return mergeAdjacentByApp([...sessions].reverse()).map((s) => ({
    ...s,
    windows: dedupeWindowsByTimestampAndTitle(s.windows),
  }));
}

export type TimelineFilter = {
  alertsOnly: boolean;
  /** Exact exe name (case-insensitive). */
  app: string | null;
  query: string;
  /** Inclusive local day keys. */
  days: { start: string; end: string } | null;
};

export function filterTimelineSessions(sessions: Session[], filter: TimelineFilter): Session[] {
  let xs = sessions;
  if (filter.alertsOnly) xs = xs.filter((s) => (s.alertEvents?.length ?? 0) > 0);
  if (filter.app) {
    const key = filter.app.toLowerCase();
    xs = xs.filter((s) => (s.appName || "").toLowerCase() === key);
  }
  if (filter.query.trim()) {
    xs = xs.filter((s) => sessionMatchesSearch(s, filter.query));
  }
  const days = filter.days;
  if (days) {
    xs = xs.filter((s) => {
      const k = dayKey(s.startTime);
      return k >= days.start && k <= days.end;
    });
  }
  return xs;
}

/**
 * Index of the session closest to `timestamp` (0 distance when it falls inside one). On ties a
 * real session wins over an idle one. -1 when there is no timestamp or no sessions.
 */
export function findHighlightIndex(sessions: Session[], timestamp: string | null | undefined): number {
  if (!timestamp || sessions.length === 0) return -1;
  const targetMs = new Date(timestamp).getTime();
  if (isNaN(targetMs)) return -1;
  let best = 0;
  let bestDist = Infinity;
  sessions.forEach((s, i) => {
    const start = s.startTime.getTime();
    const end = s.endTime.getTime();
    const dist = targetMs < start ? start - targetMs : targetMs > end ? targetMs - end : 0;
    const isIdle = s.appName === "__idle__";
    const bestIdle = sessions[best].appName === "__idle__";
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    } else if (dist === bestDist) {
      if (bestIdle && !isIdle) best = i;
    }
  });
  return best;
}
