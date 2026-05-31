import { describe, it, expect } from "vitest";
import {
  aggregateSessions,
  attachAlertEventsToSessions,
  formatDuration,
  type Session,
  type SessionAlertEvent,
} from "./session-aggregator";

const iso = (ms: number) => new Date(ms).toISOString();
const win = (id: number, exe: string, title: string, ms: number) => ({
  id,
  exe_name: exe,
  window_title: title,
  timestamp: iso(ms),
  user: null,
});

// aggregateSessions always appends a trailing "__idle__" segment up to "now" for past data;
// assertions filter those out and focus on the real foreground sessions.
const realSessions = (s: Session[]) => s.filter((x) => x.appName !== "__idle__");

describe("aggregateSessions", () => {
  it("returns nothing when there are no windows", () => {
    expect(aggregateSessions({ windows: [], urls: [], keystrokes: [] })).toEqual([]);
  });

  it("groups consecutive same-app windows into one session", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const sessions = realSessions(
      aggregateSessions({
        windows: [
          win(1, "code.exe", "a.ts - Code", base),
          win(2, "code.exe", "b.ts - Code", base + 10_000),
        ],
        urls: [],
        keystrokes: [],
      }),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].appName).toBe("code.exe");
    expect(sessions[0].windows).toHaveLength(2);
  });

  it("starts a new session when the foreground app changes", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const sessions = realSessions(
      aggregateSessions({
        windows: [
          win(1, "code.exe", "a", base),
          win(2, "chrome.exe", "b", base + 10_000),
        ],
        urls: [],
        keystrokes: [],
      }),
    );
    expect(sessions.map((s) => s.appName)).toEqual(["code.exe", "chrome.exe"]);
  });

  it("inserts an idle segment across a long gap in the same app", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const all = aggregateSessions({
      windows: [
        win(1, "code.exe", "a", base),
        win(2, "code.exe", "b", base + 10 * 60_000), // 10 min later → idle gap
      ],
      urls: [],
      keystrokes: [],
    });
    expect(all.some((s) => s.appName === "__idle__")).toBe(true);
  });
});

describe("attachAlertEventsToSessions", () => {
  const mkSession = (id: string, app: string, startMs: number, endMs: number): Session => ({
    id,
    appName: app,
    appDisplayName: app,
    windowTitle: "w",
    startTime: new Date(startMs),
    endTime: new Date(endMs),
    duration: (endMs - startMs) / 1000,
    keystrokeCount: 0,
    urls: [],
    keystrokes: [],
    windows: [],
    hasKeystrokes: false,
    hasUrls: false,
  });
  const mkAlert = (id: number, ms: number): SessionAlertEvent => ({
    id,
    rule_name: `r${id}`,
    channel: "c",
    snippet: "s",
    created_at: iso(ms),
    has_screenshot: false,
    screenshot_requested: false,
  });

  it("returns sessions unchanged (but with empty alertEvents) when there are no events", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const out = attachAlertEventsToSessions([mkSession("a", "code.exe", base, base + 1000)], []);
    expect(out[0].alertEvents).toEqual([]);
  });

  it("attaches each event to the nearest session by time", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const sessions = [
      mkSession("a", "code.exe", base, base + 60_000),
      mkSession("b", "chrome.exe", base + 120_000, base + 180_000),
    ];
    const out = attachAlertEventsToSessions(sessions, [
      mkAlert(1, base + 30_000), // inside session a
      mkAlert(2, base + 150_000), // inside session b
    ]);
    expect(out[0].alertEvents?.map((e) => e.id)).toEqual([1]);
    expect(out[1].alertEvents?.map((e) => e.id)).toEqual([2]);
  });

  it("sorts attached events chronologically within a session", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const sessions = [mkSession("a", "code.exe", base, base + 60_000)];
    const out = attachAlertEventsToSessions(sessions, [
      mkAlert(2, base + 40_000),
      mkAlert(1, base + 10_000),
    ]);
    expect(out[0].alertEvents?.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(5)).toBe("5s");
    expect(formatDuration(90)).toBe("1m");
    expect(formatDuration(3 * 3600 + 25 * 60)).toBe("3h 25m");
  });
});
