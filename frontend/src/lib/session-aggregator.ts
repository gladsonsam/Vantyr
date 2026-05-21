// Session aggregator for timeline visualization
// Combines windows, URLs, and keystrokes into logical sessions

import { prettyAppLabel } from "./app-names";

interface WindowEvent {
  id: number;
  window_title: string;
  exe_name: string;
  app_display?: string;
  timestamp: string;
  user?: string | null;
}

interface URLEvent {
  id: number;
  url: string;
  browser: string;
  timestamp: string;
  user?: string | null;
}

interface KeystrokeEvent {
  id: number;
  window_title: string;
  exe_name: string;
  app_display?: string;
  keys: string;
  timestamp: string;
  user?: string | null;
}

/** Alert rule firings shown on the activity timeline (screenshots load from the API by id). */
export interface SessionAlertEvent {
  id: number;
  rule_name: string;
  channel: string;
  snippet: string;
  created_at: string;
  has_screenshot: boolean;
  screenshot_requested: boolean;
}

export interface Session {
  id: string;
  /** Optional agent id (for UI helpers like app icon URLs). */
  agentId?: string;
  /** Best-effort logged-in user for this session (`DOMAIN\\user`). */
  user?: string | null;
  appName: string;
  appDisplayName: string;
  windowTitle: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  keystrokeCount: number;
  urls: URLEvent[];
  keystrokes: KeystrokeEvent[];
  windows: WindowEvent[];
  hasKeystrokes: boolean;
  hasUrls: boolean;
  /** Fires attached by timestamp to this session (chronological within the card). */
  alertEvents?: SessionAlertEvent[];
}

interface AggregateSessionsOptions {
  windows: WindowEvent[];
  urls: URLEvent[];
  keystrokes: KeystrokeEvent[];
  gapThresholdSeconds?: number;
  /**
   * If the time between consecutive foreground window events exceeds this,
   * insert an explicit "Idle / Away" segment to keep the timeline continuous.
   */
  idleThresholdSeconds?: number;
}

function normalizeSpace(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function isBlankWindowEvent(w: WindowEvent): boolean {
  return (
    normalizeSpace(w.exe_name) === "" &&
    normalizeSpace(w.window_title) === "" &&
    normalizeSpace(w.app_display) === ""
  );
}

function isGenericWindowsOsName(name: string): boolean {
  const n = normalizeSpace(name).toLowerCase();
  return (
    n === "microsoft windows operating system" ||
    n === "microsoft® windows® operating system" ||
    n.includes("windows operating system")
  );
}

function lastTitleSegment(title: string): string {
  // Common pattern: "something - AppName"
  const t = normalizeSpace(title);
  const idx = t.lastIndexOf(" - ");
  if (idx >= 0) return t.slice(idx + 3).trim();
  return t;
}

function deriveAppDisplayName(window: WindowEvent): string {
  const exe = normalizeSpace(window.exe_name).toLowerCase();
  const title = normalizeSpace(window.window_title);
  const titleTail = lastTitleSegment(title);
  const meta = normalizeSpace(window.app_display);

  // Windows lock screen host process.
  if (exe === "lockapp" || exe === "lockapp.exe") {
    return "Lock screen";
  }

  // Microsoft Office: normalize corrupt/concatenated "Microsoft OfficeWINWORD. EXE" style labels
  // and prefer friendly names like "Microsoft Word".
  {
    const officePretty = prettyAppLabel({ exeName: window.exe_name, appDisplay: window.app_display });
    if (officePretty && officePretty !== meta && officePretty !== window.exe_name) return officePretty;
  }

  // UWP/packaged apps often run under a host process like ApplicationFrameHost.
  // In that case the window title is the "real" app name (e.g. "Calculator").
  if (exe === "applicationframehost.exe") {
    if (titleTail) return titleTail;
    if (title) return title;
  }

  // Explorer's version metadata is frequently generic; the UI should call it File Explorer.
  if (exe === "explorer.exe") {
    if (titleTail.toLowerCase() === "file explorer") return "File Explorer";
    if (title.toLowerCase().includes("file explorer")) return "File Explorer";
    if (meta && !isGenericWindowsOsName(meta)) return meta;
    return "File Explorer";
  }

  // If metadata is a generic OS name, prefer the (often meaningful) window title.
  if (meta && isGenericWindowsOsName(meta)) {
    if (titleTail) return titleTail;
    if (title) return title;
    return window.exe_name;
  }

  return meta || window.exe_name;
}

/**
 * Known browser executable names (lower-case).
 * URLs captured by the agent should only ever be attributed to one of these.
 */
const BROWSER_EXES = new Set([
  "chrome.exe",
  "chromium.exe",
  "firefox.exe",
  "msedge.exe",
  "helium.exe",
  "brave.exe",
  "opera.exe",
  "vivaldi.exe",
  "iexplore.exe",
  "waterfox.exe",
  "librewolf.exe",
  "thorium.exe",
  "arc.exe",
  "safari.exe",
  "min.exe",
]);

function isBrowser(appName: string): boolean {
  return BROWSER_EXES.has(appName.toLowerCase());
}

function isTaskSwitchingNoiseEvent(win: WindowEvent): boolean {
  const exe = normalizeSpace(win.exe_name).toLowerCase();
  const title = normalizeSpace(win.window_title).toLowerCase();
  if (exe !== "explorer.exe") return false;
  // The OS task switcher/task view surfaces as an Explorer foreground window.
  // Treat it as UI noise; users generally don't want it as an activity.
  return (
    title === "task switching" ||
    title === "task view" ||
    title === "snap assist" ||
    title.includes("task switching") ||
    title.includes("task view") ||
    title.includes("snap assist")
  );
}

/**
 * Redistribute all URLs so they only appear in browser sessions.
 *
 * Strategy (in order of preference for each URL):
 *  1. The browser session whose time range contains the URL's timestamp.
 *  2. The browser session closest in time (by distance to its [start, end] interval).
 *
 * If there are no browser sessions at all the URLs stay where the
 * time-range pass already put them (graceful fallback).
 */
function redistributeUrlsToBrowserSessions(
  sessions: Session[],
  allUrls: URLEvent[],
  gapMs: number,
): void {
  const browserSessions = sessions.filter((s) => isBrowser(s.appName));
  if (browserSessions.length === 0) return;

  // Clear URLs from every session — we'll re-assign from scratch.
  for (const s of sessions) {
    s.urls = [];
    s.hasUrls = false;
  }

  for (const url of allUrls) {
    const urlMs = new Date(url.timestamp).getTime();

    // 1. Find a browser session whose range brackets this URL.
    const containing = browserSessions.find((s) => {
      const startMs = s.startTime.getTime();
      const endMs = s.endTime.getTime();
      return urlMs >= startMs && urlMs <= endMs + gapMs;
    });

    if (containing) {
      containing.urls.push(url);
      continue;
    }

    // 2. Fall back to the nearest browser session by interval distance.
    let nearest = browserSessions[0];
    let nearestDist = Infinity;
    for (const s of browserSessions) {
      const startMs = s.startTime.getTime();
      const endMs = s.endTime.getTime();
      // Distance = 0 if inside the interval, otherwise gap to nearest edge.
      const dist =
        urlMs < startMs ? startMs - urlMs : urlMs > endMs ? urlMs - endMs : 0;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = s;
      }
    }
    nearest.urls.push(url);
  }

  // Recompute hasUrls flag.
  for (const s of sessions) {
    s.hasUrls = s.urls.length > 0;
  }
}

export function aggregateSessions({
  windows,
  urls,
  keystrokes,
  gapThresholdSeconds = 300,
  idleThresholdSeconds = 30,
}: AggregateSessionsOptions): Session[] {
  if (windows.length === 0) return [];

  const sessions: Session[] = [];
  let currentSession: Session | null = null;

  const sortedWindows = [...windows]
    .filter((w) => !isBlankWindowEvent(w))
    .filter((w) => !isTaskSwitchingNoiseEvent(w))
    .sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const window of sortedWindows) {
    const windowTime = new Date(window.timestamp);

    const shouldStartNew =
      !currentSession ||
      currentSession.appName !== window.exe_name ||
      (windowTime.getTime() - currentSession.endTime.getTime()) / 1000 >
        gapThresholdSeconds;

    if (shouldStartNew) {
      if (currentSession) {
        sessions.push(currentSession);
      }

      currentSession = {
        id: `session-${window.id}-${windowTime.getTime()}`,
        user: window.user ?? null,
        appName: window.exe_name,
        appDisplayName: deriveAppDisplayName(window),
        windowTitle: window.window_title,
        startTime: windowTime,
        endTime: windowTime,
        duration: 0,
        keystrokeCount: 0,
        urls: [],
        keystrokes: [],
        windows: [window],
        hasKeystrokes: false,
        hasUrls: false,
      };
    } else if (currentSession) {
      currentSession.endTime = windowTime;
      currentSession.windowTitle = window.window_title;
      // Some executables host multiple "real" apps (e.g. ApplicationFrameHost.exe).
      // Keep the display name aligned with the most recent foreground title.
      currentSession.appDisplayName = deriveAppDisplayName(window);
      if (!currentSession.user && window.user) currentSession.user = window.user;
      currentSession.windows.push(window);
    }
  }

  if (currentSession) {
    sessions.push(currentSession);
  }

  const gapMs = gapThresholdSeconds * 1000;
  const idleMs = idleThresholdSeconds * 1000;

  // Build a continuous timeline:
  // - If the next window event comes soon, extend the current session to it.
  // - If there's a long gap, insert an explicit Idle segment.
  const timeline: Session[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const next = sessions[i + 1];
    if (!next) {
      timeline.push(s);
      break;
    }

    const gap = next.startTime.getTime() - s.endTime.getTime();
    if (gap > 0 && gap <= idleMs) {
      // "Continuous" foreground: stretch to the next event.
      s.endTime = new Date(next.startTime);
      timeline.push(s);
      continue;
    }

    if (gap > idleMs) {
      // Large gap: keep session end at its last observed event,
      // and insert an explicit idle segment for the gap.
      timeline.push(s);
      timeline.push({
        id: `idle-${s.endTime.getTime()}-${next.startTime.getTime()}`,
        appName: "__idle__",
        user: s.user ?? null,
        appDisplayName: "Idle / Away",
        windowTitle: "No foreground window events",
        startTime: new Date(s.endTime),
        endTime: new Date(next.startTime),
        duration: 0,
        keystrokeCount: 0,
        urls: [],
        keystrokes: [],
        windows: [],
        hasKeystrokes: false,
        hasUrls: false,
      });
      continue;
    }

    // Overlapping/duplicate timestamps: just push.
    timeline.push(s);
  }

  // Extend the tail to "now" (or insert idle if we've gone quiet).
  const last = timeline[timeline.length - 1];
  if (last) {
    let maxEventMs = 0;
    if (sortedWindows.length > 0) {
      maxEventMs = new Date(sortedWindows[sortedWindows.length - 1].timestamp).getTime();
    }
    for (const u of urls) {
      const t = new Date(u.timestamp).getTime();
      if (t > maxEventMs) maxEventMs = t;
    }
    for (const k of keystrokes) {
      const t = new Date(k.timestamp).getTime();
      if (t > maxEventMs) maxEventMs = t;
    }
    const nowMs = Date.now();
    const tailGap = nowMs - Math.max(last.endTime.getTime(), maxEventMs);
    if (tailGap > idleMs) {
      // Add an explicit idle segment up to now.
      timeline.push({
        id: `idle-${Math.max(last.endTime.getTime(), maxEventMs)}-${nowMs}`,
        appName: "__idle__",
        user: last.user ?? null,
        appDisplayName: "Idle / Away",
        windowTitle: "No foreground window events",
        startTime: new Date(Math.max(last.endTime.getTime(), maxEventMs)),
        endTime: new Date(nowMs),
        duration: 0,
        keystrokeCount: 0,
        urls: [],
        keystrokes: [],
        windows: [],
        hasKeystrokes: false,
        hasUrls: false,
      });
    } else {
      // Still “current”: stretch last segment to now.
      if (nowMs > last.endTime.getTime()) {
        last.endTime = new Date(nowMs);
      }
    }
  }

  for (const session of timeline) {
    const startMs = session.startTime.getTime();
    const endMs = session.endTime.getTime();

    // Keystrokes: still attributed by time range + matching exe (correct as-is).
    session.keystrokes = keystrokes.filter((key) => {
      const keyTime = new Date(key.timestamp).getTime();
      return (
        keyTime >= startMs &&
        keyTime <= endMs + gapMs &&
        key.exe_name === session.appName
      );
    });

    session.keystrokeCount = session.keystrokes.reduce(
      (sum, ks) => sum + ks.keys.length,
      0
    );

    session.duration = Math.max(
      0,
      Math.floor((session.endTime.getTime() - session.startTime.getTime()) / 1000)
    );

    session.hasKeystrokes = session.keystrokes.length > 0;
    if (!session.user) {
      const u =
        session.keystrokes.find((k) => k.user)?.user ??
        session.urls.find((u) => u.user)?.user ??
        session.windows.find((w) => w.user)?.user ??
        null;
      if (u) session.user = u;
    }
  }

  // Redistribute URLs to browser sessions only.
  redistributeUrlsToBrowserSessions(timeline, urls, gapMs);

  return timeline;
}

/**
 * Map each alert event to the activity session whose time range best contains `created_at`.
 * Uses the same boundary rule as the timeline highlight: ties go to real activity over `__idle__`.
 */
export function attachAlertEventsToSessions(
  sessions: Session[],
  events: SessionAlertEvent[],
): Session[] {
  if (sessions.length === 0) return sessions;
  const withAlerts = sessions.map((s) => ({ ...s, alertEvents: [] as SessionAlertEvent[] }));
  if (events.length === 0) return withAlerts;

  for (const ev of events) {
    const targetMs = new Date(ev.created_at).getTime();
    if (isNaN(targetMs)) continue;

    let best = 0;
    let bestDist = Infinity;
    withAlerts.forEach((s, i) => {
      const start = s.startTime.getTime();
      const end = s.endTime.getTime();
      const dist = targetMs < start ? start - targetMs : targetMs > end ? targetMs - end : 0;
      const isIdle = s.appName === "__idle__";
      const bestIdle = withAlerts[best].appName === "__idle__";
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      } else if (dist === bestDist && bestIdle && !isIdle) {
        best = i;
      }
    });
    withAlerts[best].alertEvents.push(ev);
  }

  for (const s of withAlerts) {
    s.alertEvents.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }
  return withAlerts;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function getSessionColor(session: Session): string {
  if (session.hasKeystrokes && session.hasUrls) return "var(--sentinel-primary)";
  if (session.hasKeystrokes) return "var(--sentinel-success)";
  if (session.hasUrls) return "var(--sentinel-warning)";
  return "var(--awsui-color-text-body-secondary)";
}
