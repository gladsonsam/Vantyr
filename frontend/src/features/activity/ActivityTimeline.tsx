import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Globe,
  Keyboard,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Layout,
  Moon,
  Bell,
  ImageIcon,
  Calendar,
  Lock,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScreenshotDialog } from "@/components/common/ScreenshotDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Session, type SessionAlertEvent, formatDuration } from "@/features/activity/sessionAggregator";
import { apiUrl } from "@/api";
import "@/features/activity/timeline.css";
import { fmtDateTimePrecise, parseTimestamp } from "@/lib/utils";
import { AppIcon } from "@/components/common/AppIcon";
import { alertChannelLabel } from "@/features/activity/alertChannels";
import {
  applyActivityStateToSearchParams,
  encodeActivityState,
  readActivityStateFromSearchParams,
  type ActivityUrlStateV1,
} from "@/features/activity/activityUrl";

interface ActivityTimelineProps {
  /** When set, Activity filters can be synced to `?activity=` in the URL. */
  agentId?: string;
  sessions: Session[];
  loading?: boolean;
  onRefresh?: () => void;
  onLoadMore?: () => void;
  hasMoreOlder?: boolean;
  loadingMore?: boolean;
  /** ISO string timestamp — scroll to and highlight the nearest session */
  highlightTimestamp?: string | null;
}

// ── Date/time helpers ─────────────────────────────────────────────────────────

function fmtTime(date: Date): string {
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
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDayHeading(dayKey: string): string {
  const [y, mo, da] = dayKey.split("-").map(Number);
  const d = new Date(y, mo - 1, da);
  return d.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function sessionMatchesSearch(session: Session, q: string): boolean {
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

function isLockScreenApp(exeName: string): boolean {
  const n = (exeName ?? "").trim().toLowerCase();
  return n === "lockapp" || n === "lockapp.exe";
}

type DayGroup = {
  dayKey: string;
  label: string;
  items: { session: Session; idx: number }[];
};

function groupSessionsByDay(sessions: Session[]): DayGroup[] {
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

/** Absolute calendar-day range filter (ISO `YYYY-MM-DD` day bounds, inclusive). */
export type ActivityDateValue = {
  type: "absolute";
  startDate: string;
  endDate: string;
} | null;

function parseISODateToLocalDay(dateIso: string | undefined): Date {
  if (!dateIso) return new Date(NaN);
  const datePart = dateIso.split("T")[0] ?? dateIso;
  const parts = datePart.split("-").map((x) => parseInt(x, 10));
  if (parts.length < 3) return new Date(NaN);
  const [y, m, d] = parts;
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return new Date(NaN);
  return new Date(y, m - 1, d);
}

function resolveDateRangeToDayBounds(
  value: ActivityDateValue,
): { start: string; end: string } | null {
  if (!value) return null;
  const s = parseISODateToLocalDay(value.startDate);
  const e = parseISODateToLocalDay(value.endDate);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
  const start = dayKey(s);
  const end = dayKey(e);
  return start <= end ? { start, end } : { start: end, end: start };
}

type DatePresetKey = "all" | "today" | "last-7" | "last-30" | "custom";

const DATE_PRESETS: { key: Exclude<DatePresetKey, "custom">; label: string; days: number | null }[] = [
  { key: "all", label: "All days", days: null },
  { key: "today", label: "Today", days: 1 },
  { key: "last-7", label: "Last 7 days", days: 7 },
  { key: "last-30", label: "Last 30 days", days: 30 },
];

function absoluteRangeForPresetDays(days: number): { start: string; end: string } {
  const today = new Date();
  const endDay = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  const startD = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  startD.setDate(startD.getDate() - days + 1);
  return { start: dayKey(startD), end: endDay };
}

/** Which preset the current value corresponds to (`custom` for hand-picked dates). */
function presetKeyForValue(value: ActivityDateValue): DatePresetKey {
  if (!value) return "all";
  const bounds = resolveDateRangeToDayBounds(value);
  if (!bounds) return "custom";
  for (const preset of DATE_PRESETS) {
    if (preset.days == null) continue;
    const expected = absoluteRangeForPresetDays(preset.days);
    if (expected.start === bounds.start && expected.end === bounds.end) return preset.key;
  }
  return "custom";
}

function formatTimeRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
  const startStr = start.toLocaleTimeString([], opts);
  const endStr = end.toLocaleTimeString([], opts);
  if (!isSameDay(start, end)) {
    return `${fmtDate(start)} ${startStr} – ${fmtDate(end)} ${endStr}`;
  }
  return `${startStr} – ${endStr}`;
}

function mergeAlertEvents(
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

function mergeAdjacentByApp(sessions: Session[]): Session[] {
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

function dedupeWindowsByTimestampAndTitle(windows: Session["windows"]) {
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
type MergedActivityRow =
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
function buildMergedActivityTimeline(session: Session): MergedActivityRow[] {
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
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** Renders a captured URL as a link only when its scheme is http(s); otherwise plain text. */
function UrlRow({ url, browser }: { url: string; browser?: string }) {
  const text = url.length > 120 ? url.slice(0, 120) + "…" : url;
  const inner = (
    <>
      <ExternalLink size={10} className="vtl-url-icon" />
      <span className="vtl-url-text">{text}</span>
      {browser ? <span className="vtl-url-browser">{browser}</span> : null}
    </>
  );
  return isHttpUrl(url) ? (
    <a href={url} target="_blank" rel="noreferrer" className="vtl-merged-url-row">
      {inner}
    </a>
  ) : (
    <span className="vtl-merged-url-row" title="Non-web URL (not linkable)">
      {inner}
    </span>
  );
}

function MergedActivityRowView({
  row,
  onOpenScreenshot,
  agentId,
  onActivityDeepLink,
}: {
  row: MergedActivityRow;
  onOpenScreenshot: (eventId: number) => void;
  agentId?: string;
  onActivityDeepLink?: (state: ActivityUrlStateV1) => void;
}) {
  if (row.kind === "window") {
    const win = row.window;
    return (
      <div className="vtl-merged-row vtl-merged-row--kind-window">
        <div className="vtl-merged-head">
          <span className="vtl-merged-time">{fmtDateTimePrecise(win.timestamp)}</span>
          <span className="text-xs font-medium text-muted-foreground">Window</span>
          {agentId && onActivityDeepLink && (win.window_title ?? "").trim() ? (
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onActivityDeepLink({ v: 1, q: win.window_title });
              }}
            >
              Search
            </Button>
          ) : null}
        </div>
        <div className="vtl-merged-body">
          <span className="vtl-merged-window-line">
            <Layout size={12} className="vtl-merged-icon" />
            <span title={win.window_title} className="vtl-merged-window-title">{win.window_title}</span>
          </span>
        </div>
      </div>
    );
  }

  if (row.kind === "page") {
    const { window: win, url: u } = row;
    return (
      <div className="vtl-merged-row vtl-merged-row--kind-page">
        <div className="vtl-merged-head">
          <span className="vtl-merged-time">{fmtDateTimePrecise(win.timestamp)}</span>
          <span title="Window and URL captured together" className="text-xs font-medium text-info">
            Page
          </span>
          {agentId && onActivityDeepLink && u.url.trim() ? (
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onActivityDeepLink({ v: 1, q: u.url });
              }}
            >
              Search URL
            </Button>
          ) : null}
        </div>
        <div className="vtl-merged-body">
          <span className="vtl-merged-window-line">
            <Layout size={12} className="vtl-merged-icon" />
            <span title={win.window_title} className="vtl-merged-window-title">{win.window_title}</span>
          </span>
          <UrlRow url={u.url} browser={u.browser} />
        </div>
      </div>
    );
  }

  if (row.kind === "url") {
    const u = row.url;
    return (
      <div className="vtl-merged-row vtl-merged-row--kind-url">
        <div className="vtl-merged-head">
          <span className="vtl-merged-time">{fmtDateTimePrecise(u.timestamp)}</span>
          <span className="text-xs font-medium text-info">URL</span>
          {agentId && onActivityDeepLink && u.url.trim() ? (
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onActivityDeepLink({ v: 1, q: u.url });
              }}
            >
              Search URL
            </Button>
          ) : null}
        </div>
        <div className="vtl-merged-body">
          <UrlRow url={u.url} browser={u.browser} />
        </div>
      </div>
    );
  }

  const ev = row.alert;
  const ruleName = (ev.rule_name || "—").trim() || "—";
  const triggerText = (ev.snippet || "").trim();
  const triggerLooksLikeUrl = isHttpUrl(triggerText);
  return (
    <div className="vtl-merged-row vtl-merged-row--kind-alert">
      <div className="vtl-merged-head">
        <span className="vtl-merged-time">{fmtDateTimePrecise(ev.created_at)}</span>
        <span className="text-xs font-medium text-destructive">Alert</span>
        <span className="text-xs text-muted-foreground">
          {alertChannelLabel(ev.channel)}
        </span>
      </div>
      <div className="vtl-merged-body">
        <div className="vtl-alert-detail">
          <div className="vtl-alert-detail-row">
            <div className="vtl-alert-detail-label">Rule</div>
            <div className="vtl-alert-detail-value vtl-alert-detail-value--rule">{ruleName}</div>
          </div>
          <div className="vtl-alert-detail-row">
            <div className="vtl-alert-detail-label">Trigger</div>
            <div className="vtl-alert-detail-value">
              {triggerText ? (
                triggerLooksLikeUrl ? (
                  <a
                    className="vtl-alert-trigger-link font-mono"
                    href={triggerText}
                    target="_blank"
                    rel="noreferrer"
                    title={triggerText}
                  >
                    {triggerText}
                  </a>
                ) : (
                  <span className="vtl-alert-trigger-text font-mono" title={triggerText}>
                    {triggerText}
                  </span>
                )
              ) : (
                <span className="vtl-alert-trigger-missing">—</span>
              )}
            </div>
          </div>
        </div>
        {ev.has_screenshot ? (
          <button
            type="button"
            className="vtl-alert-shot-btn"
            onClick={() => onOpenScreenshot(ev.id)}
            title="View full size"
          >
            <img
              src={apiUrl(`/alert-rule-events/${ev.id}/screenshot`)}
              alt=""
              className="vtl-alert-shot-thumb"
              loading="lazy"
            />
            <span className="vtl-alert-shot-hint">
              <ImageIcon size={12} /> Full size
            </span>
          </button>
        ) : ev.screenshot_requested ? (
          <p className="vtl-alert-shot-miss">
            No screenshot yet.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ── Session item ──────────────────────────────────────────────────────────────

/** Count in a session's meta line: muted icon + number, named by its tooltip. */
function MetaCount({
  icon: Icon,
  count,
  label,
  iconClassName,
}: {
  icon: LucideIcon;
  count: number;
  label: string;
  iconClassName?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums" />}
      >
        <Icon size={11} aria-hidden="true" className={iconClassName} />
        <span className="sr-only">{label}: </span>
        {count}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function SessionItem({
  session,
  isLast,
  highlighted,
  forceExpanded,
  onOpenScreenshot,
  onFilterApp,
  agentId,
  onActivityDeepLink,
}: {
  session: Session;
  isLast: boolean;
  highlighted: boolean;
  forceExpanded: boolean;
  onOpenScreenshot: (eventId: number) => void;
  onFilterApp: (exeName: string) => void;
  agentId?: string;
  onActivityDeepLink?: (state: ActivityUrlStateV1) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const [showAllKeystrokes, setShowAllKeystrokes] = useState(false);
  const isOpen = userToggled ? expanded : forceExpanded || expanded;

  const mergedTimeline = useMemo(() => buildMergedActivityTimeline(session), [session]);
  const alertCount = session.alertEvents?.length ?? 0;
  const canExpand = mergedTimeline.length > 0 || session.hasKeystrokes;
  const isIdle = session.appName === "__idle__";
  const isLockScreen = !isIdle && isLockScreenApp(session.appName);

  const accent = isIdle
    ? "var(--vtl-border)"
    : session.hasKeystrokes
      ? session.hasUrls
        ? "var(--vtl-accent)"
        : "var(--vtl-success)"
      : session.hasUrls
        ? "var(--vtl-accent)"
        : "var(--vtl-border)";

  const highlightStyle: React.CSSProperties = highlighted
    ? {
      outline: "2px solid var(--success)",
      outlineOffset: 2,
      borderRadius: 8,
      boxShadow: "0 0 0 6px var(--ui-border)",
      animation: "vtl-highlight-pulse 1.8s ease 2",
    }
    : {};

  return (
    <div className="vtl-item">
      {/* Left: timestamp */}
      <div className="vtl-timestamp">
        <span className="vtl-time">{fmtTime(session.startTime)}</span>
        <span className="vtl-dur">{formatDuration(session.duration)}</span>
        {highlighted && (
          <span className="vtl-alert-pin" title="Notification fired near this time">
            <Bell size={10} />
          </span>
        )}
      </div>

      {/* Center: dot + line */}
      <div className="vtl-spine">
        <div
          className="vtl-dot"
          style={{
            borderColor: highlighted ? "var(--success)" : accent,
            boxShadow: highlighted
              ? "0 0 0 4px var(--ui-border)"
              : "0 0 0 3px var(--ui-border)",
            opacity: isIdle ? 0.55 : 1,
            transform: highlighted ? "scale(1.3)" : undefined,
          }}
        />
        {!isLast && <div className="vtl-rail" />}
      </div>

      {/* Right: card */}
      <div
        className={`vtl-card${isIdle ? " vtl-card--idle" : ""}${isIdle && !isOpen ? " vtl-card--idle-compact" : ""}${isLockScreen ? " vtl-card--lockscreen" : ""
          }`}
        style={highlightStyle}
      >
        <div
          className="vtl-card-header"
          onClick={() => {
            if (canExpand) {
              setUserToggled(true);
              setExpanded((v) => !v);
            }
          }}
          style={{ cursor: canExpand ? "pointer" : "default" }}
          role={canExpand ? "button" : undefined}
          tabIndex={canExpand ? 0 : undefined}
          onKeyDown={(e) => {
            if (canExpand && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              setUserToggled(true);
              setExpanded((v) => !v);
            }
          }}
        >
          <div className="vtl-card-main" style={{ gap: "4px" }}>
            <div className="vtl-card-title" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {isIdle && <Moon size={14} />}
              {!isIdle ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (session.appName) onFilterApp(session.appName);
                    }}
                    title="Filter timeline by this app"
                    className={isLockScreen ? "vtl-app-chip vtl-app-chip--lockscreen" : "vtl-app-chip"}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      // minHeight keeps the chip a 24px touch target without adding
                      // visual bulk on desktop: the padding stays 2px and the extra
                      // height is transparent.
                      minHeight: 24,
                      padding: "2px 8px 2px 6px",
                      borderRadius: 999,
                      border: "1px solid var(--vtl-border)",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {isLockScreen ? <Lock size={12} /> : null}
                    {session.agentId ? <AppIcon agentId={session.agentId} exeName={session.appName} size={14} /> : null}
                    <span>{session.appDisplayName || session.appName}</span>
                  </button>
                  {session.user ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "2px 8px",
                        borderRadius: 999,
                        border: "1px solid var(--ui-border)",
                        background: "var(--muted)",
                        color: "var(--muted-foreground)",
                        fontSize: 11,
                        fontWeight: 500,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {session.user}
                    </span>
                  ) : null}
                </>
              ) : (
                <span>Idle</span>
              )}
              {highlighted && (
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    color: "var(--vtl-accent)",
                    fontSize: 11,
                  }}
                >
                  <Bell size={11} /> Alert fired
                </span>
              )}
            </div>
            {!isIdle && session.windowTitle && session.windowTitle !== session.appName ? (
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: "var(--foreground)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {session.windowTitle}
              </div>
            ) : isIdle ? (
              <div style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 2 }}>
                No activity
              </div>
            ) : null}
            {!isIdle && (
              <div style={{ fontSize: "11px", color: "var(--muted-foreground)", marginTop: 1 }} className="font-mono">
                {isLockScreen ? null : session.appName}
              </div>
            )}
            <div className="vtl-card-meta">
              <span className="vtl-meta-time">{formatTimeRange(session.startTime, session.endTime)}</span>
              {session.hasKeystrokes && (
                <MetaCount icon={Keyboard} count={session.keystrokeCount} label="Keystrokes" />
              )}
              {session.hasUrls && (
                <MetaCount icon={Globe} count={session.urls.length} label="URLs visited" />
              )}
              {alertCount > 0 && (
                <MetaCount icon={Bell} count={alertCount} label="Alerts fired" iconClassName="text-destructive" />
              )}
            </div>
          </div>
          {canExpand && (
            <span className="vtl-chevron">
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          )}
        </div>

        {isOpen && (
          <div className="vtl-card-body">
            {mergedTimeline.length > 0 && (
              <div className="vtl-section">
                <p className="vtl-section-label">Timeline ({mergedTimeline.length})</p>
                <div className="vtl-merged-timeline">
                  {mergedTimeline.map((row, i) => (
                    <MergedActivityRowView
                      key={`${row.kind}-${row.kind === "window"
                          ? row.window.id
                          : row.kind === "url"
                            ? row.url.id
                            : row.kind === "page"
                              ? `${row.window.id}-${row.url.id}`
                              : row.alert.id
                        }-${i}`}
                      row={row}
                      onOpenScreenshot={onOpenScreenshot}
                      agentId={agentId}
                      onActivityDeepLink={onActivityDeepLink}
                    />
                  ))}
                </div>
              </div>
            )}

            {session.hasKeystrokes && (
              <div className="vtl-section">
                <p className="vtl-section-label">Keystrokes ({session.keystrokes.length} sessions)</p>
                <div className="vtl-key-list">
                  {(showAllKeystrokes ? session.keystrokes : session.keystrokes.slice(0, 3)).map((ks, i) => (
                    <code key={i} className="vtl-key-block">
                      {ks.keys.slice(0, 80)}
                      {ks.keys.length > 80 ? "…" : ""}
                    </code>
                  ))}
                  {session.keystrokes.length > 3 && !showAllKeystrokes && (
                    <button
                      type="button"
                      className="vtl-more"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowAllKeystrokes(true);
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        color: "inherit",
                        textAlign: "left",
                        font: "inherit",
                        opacity: 0.75,
                      }}
                    >
                      …and {session.keystrokes.length - 3} more (click to expand)
                    </button>
                  )}
                  {session.keystrokes.length > 3 && showAllKeystrokes && (
                    <button
                      type="button"
                      className="vtl-more"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowAllKeystrokes(false);
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        color: "inherit",
                        textAlign: "left",
                        font: "inherit",
                        opacity: 0.75,
                      }}
                    >
                      Show less
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ActivityTimeline({
  agentId,
  sessions,
  loading,
  onRefresh,
  onLoadMore,
  hasMoreOlder = false,
  loadingMore = false,
  highlightTimestamp,
}: ActivityTimelineProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSyncEnabled = Boolean(agentId);

  const [screenshotModalId, setScreenshotModalId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [appFilterExe, setAppFilterExe] = useState<string | null>(null);
  const [jumpRangeValue, setJumpRangeValue] = useState<ActivityDateValue>(null);
  /** Explicit expand/collapse per day; omitted keys use default (newest day expanded only). */
  const [dayExpanded, setDayExpanded] = useState<Record<string, boolean>>({});
  const [toolbarExpanded, setToolbarExpanded] = useState(false);

  const initialFilterCheck = useRef(false);
  useEffect(() => {
    const hasInitialFilters = searchQuery.trim().length > 0 || alertsOnly || jumpRangeValue != null || Boolean(appFilterExe);
    if (hasInitialFilters && !initialFilterCheck.current) {
      setToolbarExpanded(true);
      initialFilterCheck.current = true;
    }
  }, [searchQuery, alertsOnly, jumpRangeValue, appFilterExe]);

  const loadMoreVantyrRef = useRef<HTMLDivElement | null>(null);
  const lastAutoLoadMoreAtMsRef = useRef<number>(0);
  const lastUrlActivityRawRef = useRef<string | null>(null);
  const skipActivityUrlPushRef = useRef(false);

  const buildActivityStateFromUi = useCallback((): ActivityUrlStateV1 | null => {
    const q = searchQuery.trim();
    const app = appFilterExe?.trim() ? appFilterExe.trim() : null;
    const bounds = resolveDateRangeToDayBounds(jumpRangeValue);
    const from = bounds?.start ?? null;
    const to = bounds?.end ?? null;
    if (!q && !alertsOnly && !app && !from && !to) return null;
    return {
      v: 1,
      q: q || undefined,
      alerts: alertsOnly ? true : undefined,
      app,
      from,
      to,
    };
  }, [searchQuery, alertsOnly, appFilterExe, jumpRangeValue]);

  const applyActivityStateToUi = useCallback((s: ActivityUrlStateV1 | null) => {
    if (!s) {
      setSearchQuery("");
      setAlertsOnly(false);
      setAppFilterExe(null);
      setJumpRangeValue(null);
      return;
    }
    setSearchQuery(s.q ?? "");
    setAlertsOnly(Boolean(s.alerts));
    setAppFilterExe(s.app ?? null);
    if (s.from && s.to) {
      setJumpRangeValue({
        type: "absolute",
        startDate: s.from,
        endDate: s.to,
      });
    } else {
      setJumpRangeValue(null);
    }
  }, []);

  // Apply `?activity=` from the URL into UI state (deep links).
  useEffect(() => {
    if (!urlSyncEnabled) return;
    const raw = searchParams.get("activity");
    if (raw === lastUrlActivityRawRef.current) return;
    lastUrlActivityRawRef.current = raw;
    const decoded = readActivityStateFromSearchParams(searchParams);
    skipActivityUrlPushRef.current = true;
    applyActivityStateToUi(decoded);
  }, [urlSyncEnabled, searchParams, applyActivityStateToUi]);

  // Push UI state into the URL (shareable), without clobbering unrelated params.
  useEffect(() => {
    if (!urlSyncEnabled) return;
    if (skipActivityUrlPushRef.current) {
      skipActivityUrlPushRef.current = false;
      return;
    }
    const nextState = buildActivityStateFromUi();
    const encoded = nextState ? encodeActivityState(nextState) : null;
    const current = searchParams.get("activity");
    if (encoded === current) return;

    setSearchParams((prev) => applyActivityStateToSearchParams(prev, nextState), { replace: true });
    lastUrlActivityRawRef.current = encoded;
  }, [urlSyncEnabled, buildActivityStateFromUi, setSearchParams, searchParams]);

  const deepLinkToActivity = useCallback(
    (patch: ActivityUrlStateV1) => {
      if (!agentId) return;
      const qs = applyActivityStateToSearchParams(new URLSearchParams(), patch);
      navigate(`/agents/${agentId}?${qs.toString()}`);
    },
    [agentId, navigate],
  );

  const sorted = useMemo(
    () =>
      mergeAdjacentByApp([...sessions].reverse()).map((s) => ({
        ...s,
        windows: dedupeWindowsByTimestampAndTitle(s.windows),
      })),
    [sessions],
  );

  const jumpRangeBounds = useMemo(() => resolveDateRangeToDayBounds(jumpRangeValue), [jumpRangeValue]);

  /** Deferred so typing in search does not re-filter a huge list on every keystroke. */
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const filteredSorted = useMemo(() => {
    let xs = sorted;
    if (alertsOnly) xs = xs.filter((s) => (s.alertEvents?.length ?? 0) > 0);
    if (appFilterExe) {
      const key = appFilterExe.toLowerCase();
      xs = xs.filter((s) => (s.appName || "").toLowerCase() === key);
    }
    if (deferredSearchQuery.trim()) {
      xs = xs.filter((s) => sessionMatchesSearch(s, deferredSearchQuery));
    }
    if (jumpRangeBounds) {
      xs = xs.filter((s) => {
        const k = dayKey(s.startTime);
        return k >= jumpRangeBounds.start && k <= jumpRangeBounds.end;
      });
    }
    return xs;
  }, [sorted, alertsOnly, appFilterExe, deferredSearchQuery, jumpRangeBounds]);

  const dayGroups = useMemo(() => groupSessionsByDay(filteredSorted), [filteredSorted]);

  const scrollAfterDateApply = useRef(false);
  const onJumpRangeChange = useCallback((value: ActivityDateValue) => {
    setJumpRangeValue(value);
    if (value) scrollAfterDateApply.current = true;
  }, []);

  useEffect(() => {
    if (!scrollAfterDateApply.current) return;
    scrollAfterDateApply.current = false;
    const dk = dayGroups[0]?.dayKey;
    if (!dk) return;
    setDayExpanded((prev) => ({ ...prev, [dk]: true }));
    window.setTimeout(() => {
      document.getElementById(`vtl-day-${dk}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }, [jumpRangeValue, dayGroups]);

  const firstDayKey = dayGroups[0]?.dayKey ?? "";

  const isDayExpanded = useCallback(
    (key: string) => {
      if (key in dayExpanded) return dayExpanded[key]!;
      return key === firstDayKey;
    },
    [dayExpanded, firstDayKey],
  );

  const toggleDay = useCallback((key: string) => {
    setDayExpanded((prev) => {
      const current = key in prev ? prev[key]! : key === firstDayKey;
      return { ...prev, [key]: !current };
    });
  }, [firstDayKey]);

  const expandAllDays = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const g of dayGroups) next[g.dayKey] = true;
    setDayExpanded(next);
  }, [dayGroups]);

  const collapseAllDays = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const g of dayGroups) next[g.dayKey] = false;
    setDayExpanded(next);
  }, [dayGroups]);

  const anyDayExpanded = useMemo(() => {
    if (dayGroups.length === 0) return false;
    return dayGroups.some((g) => {
      if (g.dayKey in dayExpanded) return dayExpanded[g.dayKey]!;
      // Default behavior: newest day expanded only.
      return g.dayKey === firstDayKey;
    });
  }, [dayGroups, dayExpanded, firstDayKey]);

  // Find the index of the session closest to the highlight timestamp (within filtered list)
  const highlightIndex = useMemo(() => {
    if (!highlightTimestamp || filteredSorted.length === 0) return -1;
    const targetMs = new Date(highlightTimestamp).getTime();
    if (isNaN(targetMs)) return -1;
    let best = 0;
    let bestDist = Infinity;
    filteredSorted.forEach((s, i) => {
      const start = s.startTime.getTime();
      const end = s.endTime.getTime();
      const dist = targetMs < start ? start - targetMs : targetMs > end ? targetMs - end : 0;
      const isIdle = s.appName === "__idle__";
      const bestIdle = filteredSorted[best].appName === "__idle__";
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      } else if (dist === bestDist) {
        if (bestIdle && !isIdle) best = i;
      }
    });
    return best;
  }, [filteredSorted, highlightTimestamp]);

  // Open the day that contains the highlighted session (e.g. deep link from alerts)
  useEffect(() => {
    if (highlightIndex < 0 || !filteredSorted[highlightIndex]) return;
    const dk = dayKey(filteredSorted[highlightIndex].startTime);
    setDayExpanded((prev) => ({ ...prev, [dk]: true }));
  }, [highlightIndex, highlightTimestamp, filteredSorted]);

  const itemDivRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const setRef = useCallback((idx: number) => (el: HTMLDivElement | null) => {
    if (el) itemDivRefs.current.set(idx, el);
    else itemDivRefs.current.delete(idx);
  }, []);

  const lastScrolledTimestamp = useRef<string | null>(null);
  useEffect(() => {
    if (highlightIndex < 0 || !highlightTimestamp) return;
    if (lastScrolledTimestamp.current === highlightTimestamp) return;
    lastScrolledTimestamp.current = highlightTimestamp;

    const timer = setTimeout(() => {
      const el = itemDivRefs.current.get(highlightIndex);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 200);
    return () => clearTimeout(timer);
  }, [highlightIndex, highlightTimestamp]);



  const isFiltered = searchQuery.trim().length > 0 || alertsOnly || jumpRangeValue != null || Boolean(appFilterExe);
  const canAutoLoadMore =
    Boolean(onLoadMore) &&
    hasMoreOlder &&
    !loadingMore &&
    !loading &&
    !alertsOnly &&
    !jumpRangeValue &&
    !searchQuery.trim();

  // Infinite scroll: when the vantyr becomes visible, load older history in batches.
  useEffect(() => {
    const el = loadMoreVantyrRef.current;
    if (!el) return;
    if (!onLoadMore) return;

    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting);
        if (!hit) return;
        if (!canAutoLoadMore) return;
        const now = Date.now();
        // Debounce auto loads to avoid rapid-fire calls while layout shifts.
        if (now - lastAutoLoadMoreAtMsRef.current < 900) return;
        lastAutoLoadMoreAtMsRef.current = now;
        onLoadMore();
      },
      { root: null, rootMargin: "900px 0px", threshold: 0.01 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [onLoadMore, canAutoLoadMore]);
  const headerDesc = useMemo(() => {
    const base = isFiltered
      ? `${filteredSorted.length} of ${sorted.length} sessions`
      : `${sorted.length} sessions`;
    return `${base}${highlightTimestamp ? " · at alert time" : ""}`;
  }, [filteredSorted.length, sorted.length, isFiltered, highlightTimestamp]);

  if (loading && sessions.length === 0) {
    return (
      <div className="vantyr-activity-tab">
        <div className="flex justify-center px-5 py-16">
          <Spinner className="size-6" />
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="vantyr-activity-tab">
        <div className="px-5 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No activity yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="vantyr-activity-tab">
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="text-sm text-muted-foreground">{headerDesc}</p>
            <div className="flex items-center gap-2">
              <Button
                variant={toolbarExpanded ? "default" : "outline"}
                size="sm"
                onClick={() => setToolbarExpanded(!toolbarExpanded)}
              >
                Filter
              </Button>
              {onRefresh && (
                <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
                  {loading && <Spinner />} Refresh
                </Button>
              )}
            </div>
          </div>
          <div className="vtl-root" style={{ paddingTop: toolbarExpanded ? 0 : 16 }}>
            {toolbarExpanded && (
              <div className="vtl-toolbar">
                <div className="grid gap-1.5">
                  <Label htmlFor="activity-search">Search</Label>
                  <div className="vtl-toolbar-search">
                    <Input
                      id="activity-search"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="App, URL, window, keys…"
                      type="search"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">Loaded history only.</p>
                </div>
                <div className="grid gap-1.5">
                  <Label>Date range</Label>
                  <div className="vtl-toolbar-jump flex flex-wrap items-center gap-2">
                    <Select
                      value={presetKeyForValue(jumpRangeValue)}
                      onValueChange={(key) => {
                        const preset = DATE_PRESETS.find((p) => p.key === key);
                        if (!preset) return;
                        if (preset.days == null) onJumpRangeChange(null);
                        else {
                          const bounds = absoluteRangeForPresetDays(preset.days);
                          onJumpRangeChange({ type: "absolute", startDate: bounds.start, endDate: bounds.end });
                        }
                      }}
                    >
                      <SelectTrigger className="w-36" aria-label="Filter activity by calendar date range">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DATE_PRESETS.map((preset) => (
                          <SelectItem key={preset.key} value={preset.key}>
                            {preset.label}
                          </SelectItem>
                        ))}
                        <SelectItem value="custom" disabled>
                          Custom…
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="date"
                      aria-label="Start date"
                      className="w-auto"
                      value={resolveDateRangeToDayBounds(jumpRangeValue)?.start ?? ""}
                      onChange={(event) => {
                        const picked = event.target.value;
                        const current = resolveDateRangeToDayBounds(jumpRangeValue);
                        const start = picked || current?.start || dayKey(new Date());
                        const end = current?.end || start;
                        onJumpRangeChange({
                          type: "absolute",
                          startDate: start <= end ? start : end,
                          endDate: start <= end ? end : start,
                        });
                      }}
                    />
                    <Input
                      type="date"
                      aria-label="End date"
                      className="w-auto"
                      value={resolveDateRangeToDayBounds(jumpRangeValue)?.end ?? ""}
                      onChange={(event) => {
                        const picked = event.target.value;
                        const current = resolveDateRangeToDayBounds(jumpRangeValue);
                        const end = picked || current?.end || dayKey(new Date());
                        const start = current?.start || end;
                        onJumpRangeChange({
                          type: "absolute",
                          startDate: start <= end ? start : end,
                          endDate: start <= end ? end : start,
                        });
                      }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 16, minHeight: 32, paddingBottom: 1, flexWrap: "wrap", rowGap: 8 }}>
                  <Button
                    variant="link"
                    className="h-auto shrink-0 p-0"
                    onClick={() => (anyDayExpanded ? collapseAllDays() : expandAllDays())}
                  >
                    {anyDayExpanded ? "Collapse all" : "Expand all"}
                  </Button>
                  <div className="vtl-toolbar-alerts flex shrink-0 items-center gap-2" style={{ height: "auto", position: "relative" }}>
                    <Checkbox
                      id="activity-alerts-only"
                      checked={alertsOnly}
                      onCheckedChange={(checked) => setAlertsOnly(checked === true)}
                    />
                    <Label htmlFor="activity-alerts-only">Alerts only</Label>
                  </div>
                  {appFilterExe ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span className="max-w-full truncate text-xs font-medium text-info">App: {appFilterExe}</span>
                      <Button variant="link" className="h-auto shrink-0 p-0 text-xs" onClick={() => setAppFilterExe(null)}>
                        Clear
                      </Button>
                    </div>
                  ) : null}
                  {isFiltered ? (
                    <Button
                      variant="link"
                      className="h-auto shrink-0 p-0"
                      onClick={() => {
                        setSearchQuery("");
                        setAlertsOnly(false);
                        setAppFilterExe(null);
                        setJumpRangeValue(null);
                        if (urlSyncEnabled) {
                          skipActivityUrlPushRef.current = true;
                          lastUrlActivityRawRef.current = null;
                          setSearchParams((prev) => applyActivityStateToSearchParams(prev, null), { replace: true });
                        }
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              </div>
            )}

            {filteredSorted.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No matching sessions.
              </p>
            ) : (
              <>
                <div className="vtl-list">
                  {dayGroups.map((group) => {
                    const expanded = isDayExpanded(group.dayKey);
                    return (
                      <div key={group.dayKey} id={`vtl-day-${group.dayKey}`} className="vtl-day-block">
                        <button
                          type="button"
                          className="vtl-day-header"
                          onClick={() => toggleDay(group.dayKey)}
                          aria-expanded={expanded}
                        >
                          <ChevronRight
                            size={16}
                            className={`vtl-day-chevron ${expanded ? "vtl-day-chevron--open" : ""}`}
                            aria-hidden
                          />
                          <Calendar size={15} style={{ opacity: 0.85 }} aria-hidden />
                          <span className="vtl-day-header-label">{group.label}</span>
                          <span className="vtl-day-header-cta">
                            {group.items.length} session{group.items.length === 1 ? "" : "s"}
                          </span>
                        </button>
                        {expanded && (
                          <div className="vtl-day-body">
                            {group.items.map(({ session, idx }) => {
                              const isHighlighted = idx === highlightIndex && highlightTimestamp != null;
                              return (
                                <div key={session.id} ref={isHighlighted ? setRef(idx) : undefined}>
                                  <SessionItem
                                    session={session}
                                    isLast={idx === filteredSorted.length - 1}
                                    highlighted={isHighlighted}
                                    forceExpanded={isHighlighted}
                                    onOpenScreenshot={setScreenshotModalId}
                                    onFilterApp={(exe) =>
                                      setAppFilterExe((prev) =>
                                        prev?.toLowerCase() === exe.toLowerCase() ? null : exe
                                      )
                                    }
                                    agentId={agentId}
                                    onActivityDeepLink={deepLinkToActivity}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Infinite scroll vantyr (always present so observer can attach). */}
                <div ref={loadMoreVantyrRef} style={{ height: 1 }} />
                {onLoadMore && !jumpRangeValue && !alertsOnly && !searchQuery.trim() ? (
                  <div className="grid justify-items-center gap-2 py-6 text-center">
                    {hasMoreOlder ? (
                      <Button
                        variant="outline"
                        onClick={onLoadMore}
                        disabled={loadingMore || Boolean(loading)}
                      >
                        {loadingMore && <Spinner />} Load older
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        End of activity.
                      </p>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      </div>
      <ScreenshotDialog
        title="Alert screenshot"
        eventId={screenshotModalId}
        onClose={() => setScreenshotModalId(null)}
      />
    </>
  );
}
