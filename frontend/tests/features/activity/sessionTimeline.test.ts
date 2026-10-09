import { describe, expect, it } from "vitest";
import type { Session, SessionAlertEvent } from "@/features/activity/sessionAggregator";
import {
  buildMergedActivityTimeline,
  dayKey,
  dedupeWindowsByTimestampAndTitle,
  filterTimelineSessions,
  findHighlightIndex,
  groupSessionsByDay,
  isHttpUrl,
  isLockScreenApp,
  mergeAdjacentByApp,
  mergeAlertEvents,
  prepareTimelineSessions,
  sessionMatchesSearch,
} from "@/features/activity/sessionTimeline";

const iso = (ms: number) => new Date(ms).toISOString();
const BASE = new Date(2026, 0, 15, 9, 0, 0).getTime();

function session(overrides: Partial<Session> & { start: number; end: number }): Session {
  const { start, end, ...rest } = overrides;
  return {
    id: `s-${start}`,
    appName: "code.exe",
    appDisplayName: "Visual Studio Code",
    windowTitle: "main.rs",
    startTime: new Date(start),
    endTime: new Date(end),
    duration: Math.round((end - start) / 1000),
    keystrokeCount: 0,
    urls: [],
    keystrokes: [],
    windows: [],
    hasKeystrokes: false,
    hasUrls: false,
    ...rest,
  };
}

function alert(id: number, ms: number, extra: Partial<SessionAlertEvent> = {}): SessionAlertEvent {
  return {
    id,
    rule_name: "Rule",
    channel: "url",
    snippet: "example.com",
    created_at: iso(ms),
    has_screenshot: false,
    screenshot_requested: false,
    ...extra,
  };
}

describe("dayKey", () => {
  it("formats the local calendar day as YYYY-MM-DD", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 10, 30, 0, 1))).toBe("2026-11-30");
  });
});

describe("groupSessionsByDay", () => {
  it("groups by local day, newest day first, keeping each session's list index", () => {
    const dayOne = new Date(2026, 0, 14, 10).getTime();
    const dayTwo = new Date(2026, 0, 15, 10).getTime();
    const sessions = [
      session({ start: dayTwo + 60_000, end: dayTwo + 120_000 }),
      session({ start: dayTwo, end: dayTwo + 60_000 }),
      session({ start: dayOne, end: dayOne + 60_000 }),
    ];
    const groups = groupSessionsByDay(sessions);
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-01-15", "2026-01-14"]);
    expect(groups[0].items.map((i) => i.idx)).toEqual([0, 1]);
    expect(groups[1].items.map((i) => i.idx)).toEqual([2]);
    expect(groups[0].label).toContain("2026");
  });
});

describe("sessionMatchesSearch", () => {
  const s = session({
    start: BASE,
    end: BASE + 1000,
    user: "CORP\\alice",
    urls: [{ id: 1, url: "https://docs.rs/tokio", browser: "Chrome", timestamp: iso(BASE) }],
    keystrokes: [{ id: 2, window_title: "Notes", exe_name: "notepad.exe", keys: "hello world", timestamp: iso(BASE) }],
    alertEvents: [alert(3, BASE, { rule_name: "Gambling", snippet: "casino" })],
  });

  it("matches everything for an empty query", () => {
    expect(sessionMatchesSearch(s, "   ")).toBe(true);
  });

  it("matches app, user, URLs, keystrokes and alert fields case-insensitively", () => {
    expect(sessionMatchesSearch(s, "visual studio")).toBe(true);
    expect(sessionMatchesSearch(s, "alice")).toBe(true);
    expect(sessionMatchesSearch(s, "DOCS.RS")).toBe(true);
    expect(sessionMatchesSearch(s, "hello")).toBe(true);
    expect(sessionMatchesSearch(s, "gambling")).toBe(true);
    expect(sessionMatchesSearch(s, "casino")).toBe(true);
  });

  it("rejects queries that appear nowhere", () => {
    expect(sessionMatchesSearch(s, "spreadsheet")).toBe(false);
  });
});

describe("isLockScreenApp", () => {
  it("recognises the Windows lock screen host with or without .exe", () => {
    expect(isLockScreenApp("LockApp.exe")).toBe(true);
    expect(isLockScreenApp(" lockapp ")).toBe(true);
    expect(isLockScreenApp("explorer.exe")).toBe(false);
  });
});

describe("isHttpUrl", () => {
  it("only accepts http(s) schemes", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("  HTTP://example.com")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("file:///C:/x")).toBe(false);
  });
});

describe("mergeAlertEvents", () => {
  it("returns undefined when both sides are empty", () => {
    expect(mergeAlertEvents(undefined, [])).toBeUndefined();
  });

  it("dedupes by id and sorts chronologically", () => {
    const merged = mergeAlertEvents([alert(2, BASE + 2000), alert(1, BASE)], [alert(2, BASE + 2000), alert(3, BASE + 1000)]);
    expect(merged?.map((a) => a.id)).toEqual([1, 3, 2]);
  });
});

describe("mergeAdjacentByApp", () => {
  it("merges consecutive sessions of the same app (case-insensitive) and sums their data", () => {
    const a = session({
      start: BASE,
      end: BASE + 60_000,
      appName: "Code.exe",
      keystrokeCount: 3,
      hasKeystrokes: true,
      alertEvents: [alert(1, BASE)],
    });
    const b = session({
      start: BASE + 60_000,
      end: BASE + 180_000,
      appName: "code.exe",
      windowTitle: "lib.rs",
      keystrokeCount: 4,
      hasUrls: true,
      alertEvents: [alert(2, BASE + 90_000)],
    });
    const c = session({ start: BASE + 180_000, end: BASE + 200_000, appName: "chrome.exe" });
    const out = mergeAdjacentByApp([a, b, c]);
    expect(out).toHaveLength(2);
    expect(out[0].startTime.getTime()).toBe(BASE);
    expect(out[0].endTime.getTime()).toBe(BASE + 180_000);
    expect(out[0].duration).toBe(180);
    expect(out[0].windowTitle).toBe("lib.rs");
    expect(out[0].keystrokeCount).toBe(7);
    expect(out[0].hasKeystrokes).toBe(true);
    expect(out[0].hasUrls).toBe(true);
    expect(out[0].alertEvents?.map((e) => e.id)).toEqual([1, 2]);
    expect(out[1].appName).toBe("chrome.exe");
  });

  it("does not merge the same app when another app sits in between", () => {
    const out = mergeAdjacentByApp([
      session({ start: BASE, end: BASE + 1, appName: "a.exe" }),
      session({ start: BASE + 1, end: BASE + 2, appName: "b.exe" }),
      session({ start: BASE + 2, end: BASE + 3, appName: "a.exe" }),
    ]);
    expect(out).toHaveLength(3);
  });
});

describe("dedupeWindowsByTimestampAndTitle", () => {
  it("drops repeats of the same title at the same instant", () => {
    const w = (id: number, title: string, ms: number) => ({ id, window_title: title, exe_name: "x.exe", timestamp: iso(ms) });
    const out = dedupeWindowsByTimestampAndTitle([w(1, "A", BASE), w(2, "A", BASE), w(3, "B", BASE), w(4, "A", BASE + 1)]);
    expect(out.map((x) => x.id)).toEqual([1, 3, 4]);
  });
});

describe("buildMergedActivityTimeline", () => {
  const w = (id: number, title: string, ms: number) => ({ id, window_title: title, exe_name: "chrome.exe", timestamp: iso(ms) });
  const u = (id: number, url: string, ms: number) => ({ id, url, browser: "Chrome", timestamp: iso(ms) });

  it("orders rows newest first and skips untitled windows", () => {
    const rows = buildMergedActivityTimeline(
      session({
        start: BASE,
        end: BASE + 10_000,
        windows: [w(1, "First", BASE), w(2, "  ", BASE + 1000), w(3, "Second", BASE + 5000)],
        urls: [u(10, "https://a.test", BASE + 3000)],
        alertEvents: [alert(20, BASE + 4000)],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["window", "alert", "url", "window"]);
  });

  it("pairs the last window with a URL captured at the same instant into a page row", () => {
    const rows = buildMergedActivityTimeline(
      session({
        start: BASE,
        end: BASE + 10_000,
        windows: [w(1, "Earlier", BASE + 2000), w(2, "Docs - Chrome", BASE + 2000)],
        urls: [u(10, "https://docs.test", BASE + 2000)],
        alertEvents: [alert(20, BASE + 2000)],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["alert", "window", "page"]);
    const page = rows[2];
    expect(page.kind === "page" && page.window.id).toBe(1);
    expect(page.kind === "page" && page.url.id).toBe(10);
  });

  it("keeps window and URL rows separate when several URLs share the instant", () => {
    const rows = buildMergedActivityTimeline(
      session({
        start: BASE,
        end: BASE + 10_000,
        windows: [w(1, "Tab", BASE)],
        urls: [u(10, "https://a.test", BASE), u(11, "https://b.test", BASE)],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["window", "url", "url"]);
  });
});

describe("prepareTimelineSessions", () => {
  it("reverses to newest first and merges adjacent same-app sessions", () => {
    const out = prepareTimelineSessions([
      session({ start: BASE, end: BASE + 1000, appName: "a.exe" }),
      session({ start: BASE + 1000, end: BASE + 2000, appName: "b.exe" }),
      session({ start: BASE + 2000, end: BASE + 3000, appName: "b.exe" }),
    ]);
    expect(out.map((s) => s.appName)).toEqual(["b.exe", "a.exe"]);
    expect(out[0].duration).toBe(2);
  });
});

describe("filterTimelineSessions", () => {
  const sessions = [
    session({
      start: new Date(2026, 0, 15, 10).getTime(),
      end: new Date(2026, 0, 15, 11).getTime(),
      appName: "chrome.exe",
      alertEvents: [alert(1, BASE)],
    }),
    session({
      start: new Date(2026, 0, 14, 10).getTime(),
      end: new Date(2026, 0, 14, 11).getTime(),
      appName: "Code.exe",
      windowTitle: "notes.md",
    }),
  ];
  const none = { alertsOnly: false, app: null, query: "", days: null };
  const apps = (xs: Session[]) => xs.map((s) => s.appName);

  it("passes everything through without filters", () => {
    expect(filterTimelineSessions(sessions, none)).toHaveLength(2);
  });

  it("applies alerts-only, app, search and day filters", () => {
    expect(apps(filterTimelineSessions(sessions, { ...none, alertsOnly: true }))).toEqual(["chrome.exe"]);
    expect(apps(filterTimelineSessions(sessions, { ...none, app: "code.EXE" }))).toEqual(["Code.exe"]);
    expect(apps(filterTimelineSessions(sessions, { ...none, query: "notes" }))).toEqual(["Code.exe"]);
    expect(
      apps(filterTimelineSessions(sessions, { ...none, days: { start: "2026-01-15", end: "2026-01-20" } })),
    ).toEqual(["chrome.exe"]);
  });
});

describe("findHighlightIndex", () => {
  const feed = [
    session({ start: BASE + 120_000, end: BASE + 180_000, appName: "late.exe" }),
    session({ start: BASE + 60_000, end: BASE + 120_000, appName: "__idle__" }),
    session({ start: BASE, end: BASE + 60_000, appName: "early.exe" }),
  ];

  it("returns -1 without a usable timestamp", () => {
    expect(findHighlightIndex(feed, null)).toBe(-1);
    expect(findHighlightIndex(feed, "not a date")).toBe(-1);
    expect(findHighlightIndex([], iso(BASE))).toBe(-1);
  });

  it("picks the session containing the timestamp, else the nearest", () => {
    expect(findHighlightIndex(feed, iso(BASE + 30_000))).toBe(2);
    expect(findHighlightIndex(feed, iso(BASE + 600_000))).toBe(0);
  });

  it("prefers a real session over idle on a tie", () => {
    expect(findHighlightIndex(feed, iso(BASE + 60_000))).toBe(2);
  });
});
