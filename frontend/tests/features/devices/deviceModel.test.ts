import { describe, expect, it } from "bun:test";
import type {
  Agent,
  NetworkAssignment,
  NetworkConnection,
  NetworkDevice,
  NetworkPerson,
} from "@/api/types";
import {
  agentDeviceKey,
  buildDeviceRows,
  connectedCount,
} from "@/features/devices/lib/deviceModel";

const T = "2026-11-26T00:00:00Z";
const person = (id: string, name: string): NetworkPerson => ({
  id,
  household_id: "h",
  display_name: name,
  note: null,
  created_at: T,
});
const device = (
  id: string,
  label: string,
  type: NetworkDevice["device_type"] = "computer",
): NetworkDevice => ({
  id,
  canonical_key: id,
  label,
  device_type: type,
  created_at: T,
  updated_at: T,
});
const assignment = (
  id: string,
  personId: string,
  deviceId: string,
  agentId: string | null = null,
  role: NetworkAssignment["role"] = "member",
): NetworkAssignment => ({
  id,
  household_id: "h",
  person_id: personId,
  device_id: deviceId,
  agent_id: agentId,
  role,
  note: null,
  created_at: T,
  updated_at: T,
});
const connection = (
  id: string,
  assignmentId: string,
  kind: NetworkConnection["kind"],
  status: NetworkConnection["status"],
  observed: string | null = null,
): NetworkConnection => ({
  id,
  household_id: "h",
  assignment_id: assignmentId,
  kind,
  provenance: kind,
  capabilities: [],
  status,
  observed_at: observed,
  note: null,
  created_at: T,
  updated_at: T,
});
const agent = (id: string, name: string, online: boolean): Agent => ({
  id,
  name,
  first_seen: T,
  last_seen: "2026-11-25T00:00:00Z",
  icon: null,
  agent_version: null,
  online,
  connected_at: online ? "2026-11-26T01:00:00Z" : null,
  last_connected_at: null,
  last_disconnected_at: online ? null : "2026-11-25T12:00:00Z",
});

const persons = [person("alex", "Alex"), person("sam", "Sam"), person("jo", "Jo")];

describe("buildDeviceRows", () => {
  it("shows every connection of a device and what each one says", () => {
    const rows = buildDeviceRows({
      agents: [agent("a1", "Laptop", true)],
      persons,
      devices: [device("laptop", "Alex’s laptop")],
      assignments: [assignment("s1", "alex", "laptop", "a1", "owner")],
      connections: [
        connection("c1", "s1", "dns", "active", "2026-11-26T02:00:00Z"),
        connection("c2", "s1", "proxy", "stale", "2026-11-24T00:00:00Z"),
      ],
    });
    const row = rows[0];
    expect(row.connections.agent.state).toBe("connected");
    expect(row.connections.dns.state).toBe("connected");
    expect(row.connections.proxy.state).toBe("stale");
    expect(row.connections.proxy.lastSeenAt).toBe("2026-11-24T00:00:00Z");
    expect(connectedCount(row)).toBe(2);
  });

  it("keeps an agentless device, with no agent connection claimed for it", () => {
    const [tv] = buildDeviceRows({
      agents: [],
      persons,
      devices: [device("tv", "Living room TV", "tv")],
      assignments: [assignment("s1", "alex", "tv", null, "owner")],
      connections: [connection("c1", "s1", "dns", "active")],
    });
    expect(tv.agentId).toBeNull();
    expect(tv.connections.agent.state).toBe("none");
    expect(tv.connections.dns.state).toBe("connected");
    expect(tv.connections.proxy.state).toBe("none");
  });

  it("treats owner as an assignment, not as who is using the device", () => {
    const [tv] = buildDeviceRows({
      agents: [],
      persons,
      devices: [device("tv", "Living room TV", "tv")],
      assignments: [assignment("s1", "alex", "tv", null, "owner")],
      connections: [],
    });
    expect(tv.people).toHaveLength(1);
    expect(tv.people[0].role).toBe("owner");
    // One assigned person is still not a verified current user; shared only means several people.
    expect(tv.shared).toBe(false);
  });

  it("marks a device with several assigned people as shared", () => {
    const [pc] = buildDeviceRows({
      agents: [],
      persons,
      devices: [device("pc", "Shared desktop")],
      assignments: [
        assignment("s1", "alex", "pc"),
        assignment("s2", "sam", "pc"),
        assignment("s3", "jo", "pc"),
      ],
      connections: [],
    });
    expect(pc.shared).toBe(true);
    expect(pc.people.map((p) => p.person.display_name)).toEqual(["Alex", "Sam", "Jo"]);
  });

  it("lists an agent that is not in a household, so it does not disappear", () => {
    const rows = buildDeviceRows({
      agents: [agent("a1", "Claimed", true), agent("a2", "Loose agent", false)],
      persons,
      devices: [device("d1", "Claimed device")],
      assignments: [assignment("s1", "alex", "d1", "a1")],
      connections: [],
    });
    const loose = rows.find((r) => r.origin === "unclaimed_agent");
    expect(loose?.key).toBe(agentDeviceKey("a2"));
    expect(loose?.connections.agent.state).toBe("stale");
    expect(loose?.connections.dns.state).toBe("none");
    expect(rows.filter((r) => r.agentId === "a1")).toHaveLength(1);
  });

  it("takes the agent connection from the live agent, not from a stale inventory row", () => {
    const [row] = buildDeviceRows({
      agents: [agent("a1", "Laptop", false)],
      persons,
      devices: [device("laptop", "Laptop")],
      assignments: [assignment("s1", "alex", "laptop", "a1")],
      connections: [connection("c1", "s1", "agent", "active")],
    });
    expect(row.connections.agent.state).toBe("stale");
  });

  it("falls back to inventory when the linked agent is not in the live list", () => {
    const [row] = buildDeviceRows({
      agents: [],
      persons,
      devices: [device("laptop", "Laptop")],
      assignments: [assignment("s1", "alex", "laptop", "gone")],
      connections: [connection("c1", "s1", "agent", "active", "2026-11-26T00:00:00Z")],
    });
    expect(row.connections.agent.state).toBe("connected");
  });

  it("reports an error status as not connected rather than connected", () => {
    const [row] = buildDeviceRows({
      agents: [],
      persons,
      devices: [device("pc", "PC")],
      assignments: [assignment("s1", "alex", "pc")],
      connections: [connection("c1", "s1", "dns", "error")],
    });
    expect(row.connections.dns.state).toBe("stale");
  });
});
