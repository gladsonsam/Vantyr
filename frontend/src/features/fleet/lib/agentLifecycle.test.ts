import { describe, expect, it } from "vitest";
import type { Agent } from "@/api/types";
import { disconnectedAgent, retainAgents, withoutAgent } from "./agentLifecycle";

describe("device lifecycle", () => {
  it("disconnect records the actual last-seen time and clears the live connection", () => {
    const agent = { id: "a", online: true, connected_at: "before", last_seen: "before" } as Agent;
    expect(disconnectedAgent(agent, "2026-10-03T12:00:00Z")).toMatchObject({ online: false, connected_at: null, last_seen: "2026-10-03T12:00:00Z", last_disconnected_at: "2026-10-03T12:00:00Z" });
    expect(agent.online).toBe(true);
    expect(disconnectedAgent(undefined)).toBeUndefined();
  });

  it("removal preserves other device caches and does not mutate snapshots", () => {
    const cache = { removed: { hostname: "old" }, kept: { hostname: "new" } };
    expect(withoutAgent(cache, "removed")).toEqual({ kept: cache.kept });
    expect(cache.removed.hostname).toBe("old");
    expect(withoutAgent(cache, "missing")).toBe(cache);
    expect(retainAgents(cache, new Set())).toEqual({});
  });
});
