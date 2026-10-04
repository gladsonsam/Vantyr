import { describe, expect, it } from "vitest";
import { DEFAULT_FLEET_SORT, parseFleetSort, sortFleet } from "./fleetSort";

const devices = [
  { id: "z", name: "PC 10", online: true, activity: "active", internetBlocked: false },
  { id: "b", name: "pc 2", online: true, activity: "afk", internetBlocked: true },
  { id: "a", name: "PC 2", online: true, activity: "active", internetBlocked: false },
  { id: "offline", name: "PC 1", online: false, activity: "active", internetBlocked: true },
];
describe("fleet sorting", () => {
  it("sorts online first with natural names and deterministic ID ties without mutating input", () => {
    expect(sortFleet(devices).map((d) => d.id)).toEqual(["a", "b", "z", "offline"]);
    expect(sortFleet([...devices].reverse()).map((d) => d.id)).toEqual(["a", "b", "z", "offline"]);
    expect(devices[0].id).toBe("z");
  });
  it("ignores activity and blocking updates", () => {
    const changed = devices.map((d) => ({ ...d, activity: "afk", internetBlocked: !d.internetBlocked }));
    expect(sortFleet(changed).map((d) => d.id)).toEqual(sortFleet(devices).map((d) => d.id));
  });
  it("supports both explicit sort keys and directions", () => {
    expect(sortFleet(devices, { key: "name", direction: "asc" }).map((d) => d.id)).toEqual(["offline", "a", "b", "z"]);
    expect(sortFleet(devices, { key: "name", direction: "desc" }).map((d) => d.id)).toEqual(["z", "a", "b", "offline"]);
    expect(sortFleet(devices, { key: "connectivity", direction: "desc" }).map((d) => d.id)).toEqual(["offline", "z", "a", "b"]);
  });
  it("validates saved preferences and falls back for corrupt or outdated data", () => {
    for (const raw of [null, "bad json", "{}", '{"key":"activity","direction":"asc"}']) {
      expect(parseFleetSort(raw)).toEqual(DEFAULT_FLEET_SORT);
    }
    expect(parseFleetSort('{"key":"name","direction":"desc"}')).toEqual({ key: "name", direction: "desc" });
  });
  it("sorts timestamps and numeric versions while keeping unknown values last in either direction", () => {
    const rows = [
      { id: "old", name: "A", online: false, first_seen: "2025-01-01Z", last_seen: "2025-01-01Z", agent_version: "0.2.9" },
      { id: "new", name: "B", online: false, first_seen: "2026-01-01Z", last_seen: "2026-01-01Z", agent_version: "0.2.10" },
      { id: "missing", name: "C", online: false, first_seen: "", last_seen: "invalid", agent_version: null },
    ];
    for (const key of ["first_seen", "last_seen", "agent_version"] as const) {
      expect(sortFleet(rows, { key, direction: "asc" }).map(r => r.id)).toEqual(["old", "new", "missing"]);
      expect(sortFleet(rows, { key, direction: "desc" }).map(r => r.id)).toEqual(["new", "old", "missing"]);
      expect(parseFleetSort(JSON.stringify({ key, direction: "desc" }))).toEqual({ key, direction: "desc" });
    }
  });
});
