import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/api/types";
import {
  formatLastSeen,
  formatUptime,
  osFromInfo,
  statusFor,
  statusTone,
} from "@/features/agent-detail/lib/agentStatus";

const agent = (online: boolean) => ({ online }) as Agent;

describe("formatUptime", () => {
  it("formats days, hours and minutes", () => {
    expect(formatUptime(90061)).toBe("1d 1h 1m");
    expect(formatUptime(3720)).toBe("1h 2m");
    expect(formatUptime(90)).toBe("1m");
  });
  it("shows a dash for missing or negative values", () => {
    expect(formatUptime(undefined)).toBe("-");
    expect(formatUptime(null)).toBe("-");
    expect(formatUptime(-5)).toBe("-");
  });
});

describe("formatLastSeen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("reports relative times and the empty and invalid cases", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(formatLastSeen("2025-12-29T00:00:00Z")).toBe("3d ago");
    expect(formatLastSeen("2025-12-31T21:00:00Z")).toBe("3h ago");
    expect(formatLastSeen("2025-12-31T23:59:00Z")).toBe("1m ago");
    expect(formatLastSeen("2025-12-31T23:59:59Z")).toBe("1s ago");
    expect(formatLastSeen(null)).toBe("Never");
    expect(formatLastSeen("not a date")).toBe("Unknown");
  });
});

describe("osFromInfo", () => {
  it("maps OS names and kernel versions to badge kinds", () => {
    expect(osFromInfo({ os_name: "Windows 11" })).toBe("windows");
    expect(osFromInfo({ os_name: "macOS", kernel_version: "Darwin 24" })).toBe("macos");
    expect(osFromInfo({ os_name: "Ubuntu", kernel_version: "6.8.0-52-generic" })).toBe("linux");
    expect(osFromInfo({ os_name: "Docker" })).toBe("docker");
    expect(osFromInfo(null)).toBe("unknown");
  });
});

describe("statusFor", () => {
  it("prefers offline, then the live activity, then connected", () => {
    expect(statusFor(agent(false), { activity: "active" })).toEqual({ status: "offline", label: "Offline" });
    expect(statusFor(agent(true), { activity: "afk" })).toEqual({ status: "afk", label: "AFK" });
    expect(statusFor(agent(true), { activity: "active" })).toEqual({ status: "active", label: "Active now" });
    expect(statusFor(agent(true))).toEqual({ status: "connected", label: "Connected" });
  });
});

describe("statusTone", () => {
  it("carries status by hue without pill badges", () => {
    expect(statusTone("afk")).toEqual({ text: "text-warning", dot: "var(--warning)" });
    expect(statusTone("offline")).toEqual({ text: "text-muted-foreground", dot: "var(--muted-foreground)" });
    expect(statusTone("active")).toEqual({ text: "text-success", dot: "var(--success)" });
    expect(statusTone("connected")).toEqual({ text: "text-success", dot: "var(--success)" });
  });
});
