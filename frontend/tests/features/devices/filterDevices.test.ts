import { describe, expect, it } from "bun:test";
import type { DeviceRow } from "@/features/devices/lib/deviceModel";
import { filterDevices } from "@/features/devices/lib/filterDevices";

const row = (
  label: string,
  dns: "connected" | "stale" | "none",
  people: string[] = [],
): DeviceRow => ({
  key: label,
  origin: "household",
  deviceId: label,
  agentId: null,
  label,
  type: "tv",
  people: people.map((name) => ({
    assignmentId: name,
    person: { id: name, household_id: "h", display_name: name, note: null, created_at: "" },
    role: "owner" as const,
  })),
  shared: false,
  connections: {
    agent: { kind: "agent", state: "none", lastSeenAt: null, provenance: null, capabilities: [] },
    dns: { kind: "dns", state: dns, lastSeenAt: null, provenance: "dns", capabilities: [] },
    proxy: { kind: "proxy", state: "none", lastSeenAt: null, provenance: null, capabilities: [] },
  },
});

const rows = [row("Living room TV", "connected", ["Alex"]), row("Kitchen tablet", "stale", ["Jo"])];
const all = { query: "", status: "all" as const, favoritesOnly: false };

describe("filterDevices", () => {
  it("keeps everything for the all view", () => {
    expect(filterDevices(rows, all)).toHaveLength(2);
  });

  it("searches by device name and by person", () => {
    expect(filterDevices(rows, { ...all, query: "tablet" }).map((r) => r.label)).toEqual([
      "Kitchen tablet",
    ]);
    expect(filterDevices(rows, { ...all, query: "alex" }).map((r) => r.label)).toEqual([
      "Living room TV",
    ]);
  });

  it("maps the status tabs onto whether a device is reporting", () => {
    expect(filterDevices(rows, { ...all, status: "active" }).map((r) => r.label)).toEqual([
      "Living room TV",
    ]);
    expect(filterDevices(rows, { ...all, status: "offline" }).map((r) => r.label)).toEqual([
      "Kitchen tablet",
    ]);
  });

  it("shows none under Away, an idea only the agent has", () => {
    expect(filterDevices(rows, { ...all, status: "afk" })).toHaveLength(0);
  });

  it("shows none when only favourites are wanted, since favourites belong to agents", () => {
    expect(filterDevices(rows, { ...all, favoritesOnly: true })).toHaveLength(0);
  });
});
