import type {
  Agent,
  NetworkAssignment,
  NetworkAssignmentRole,
  NetworkConnection,
  NetworkConnectionKind,
  NetworkDevice,
  NetworkDeviceType,
  NetworkPerson,
  NetworkProvenance,
} from "@/api/types";

/**
 * A device is what you click. Agent, DNS and Proxy are the three ways it can talk to Vantyr, each a
 * separate connection with its own state and evidence. This module is the only place that knows how
 * the server's inventory maps onto that picture, so a change in the server shape (for example
 * connections attaching straight to a device) is a change here and nowhere else.
 */

export type ConnectionState =
  /** Reporting right now. */
  | "connected"
  /** Known, but not reporting. Says nothing about what is enforced. */
  | "stale"
  /** No such connection has ever been seen for this device. */
  | "none";

export interface ConnectionSummary {
  kind: NetworkConnectionKind;
  state: ConnectionState;
  lastSeenAt: string | null;
  /** Where the evidence for this connection came from. `null` when there is none. */
  provenance: NetworkProvenance | null;
  capabilities: string[];
}

export interface DevicePerson {
  assignmentId: string;
  person: NetworkPerson;
  /** Ownership is not activity: an owner is not necessarily who is using the device now. */
  role: NetworkAssignmentRole;
}

export type DeviceOrigin = "household" | "unclaimed_agent";

export interface DeviceRow {
  /** The route key: the household device id, or `agent:<id>` for an agent not in a household. */
  key: string;
  origin: DeviceOrigin;
  deviceId: string | null;
  agentId: string | null;
  label: string;
  type: NetworkDeviceType;
  people: DevicePerson[];
  /** More than one person is assigned, so "who is using it" is not known from assignments alone. */
  shared: boolean;
  connections: Record<NetworkConnectionKind, ConnectionSummary>;
}

export interface DeviceInput {
  agents: Agent[];
  devices: NetworkDevice[];
  persons: NetworkPerson[];
  assignments: NetworkAssignment[];
  connections: NetworkConnection[];
}

export const CONNECTION_KINDS: readonly NetworkConnectionKind[] = ["agent", "dns", "proxy"];

export function agentDeviceKey(agentId: string): string {
  return `agent:${agentId}`;
}

const none = (kind: NetworkConnectionKind): ConnectionSummary => ({
  kind,
  state: "none",
  lastSeenAt: null,
  provenance: null,
  capabilities: [],
});

/** The device a connection belongs to. Connections are about devices; people are optional. */
function connectionDeviceId(connection: NetworkConnection): string {
  return connection.device_id;
}

/** A revoked connection no longer reports anything. */
const isLive = (c: NetworkConnection) => c.status !== "revoked" && !c.revoked_at;

const newest = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));

/** One summary for every inventory connection of a kind on a device. Connected wins over stale. */
function summarise(
  kind: NetworkConnectionKind,
  connections: NetworkConnection[],
): ConnectionSummary {
  const ofKind = connections.filter((c) => c.kind === kind && isLive(c));
  if (ofKind.length === 0) return none(kind);
  const live = ofKind.filter((c) => c.status === "active");
  const chosen = live[0] ?? ofKind[0];
  return {
    kind,
    state: live.length > 0 ? "connected" : "stale",
    lastSeenAt: ofKind.reduce<string | null>(
      (acc, c) => newest(acc, c.last_seen_at ?? c.observed_at),
      null,
    ),
    provenance: chosen.provenance,
    capabilities: [...new Set(ofKind.flatMap((c) => c.capabilities))],
  };
}

/** The live agent is the source of truth for the agent connection; inventory is the fallback. */
function agentConnection(
  linkedAgentIds: string[],
  agentsById: Map<string, Agent>,
  inventory: NetworkConnection[],
): ConnectionSummary {
  const live = linkedAgentIds.map((id) => agentsById.get(id)).filter((a): a is Agent => !!a);
  if (live.length > 0) {
    const online = live.find((a) => a.online);
    const reference = online ?? live[0];
    return {
      kind: "agent",
      state: online ? "connected" : "stale",
      lastSeenAt: online
        ? (online.connected_at ?? online.last_seen)
        : (reference.last_disconnected_at ?? reference.last_seen),
      provenance: "agent",
      capabilities: [],
    };
  }
  return summarise("agent", inventory);
}

/**
 * Every device in one list: household devices with their people and connections, then any agent that
 * is not in a household yet, so no agent disappears from the dashboard.
 */
export function buildDeviceRows(input: DeviceInput): DeviceRow[] {
  const agentsById = new Map(input.agents.map((a) => [a.id, a]));
  const personsById = new Map(input.persons.map((p) => [p.id, p]));

  const claimedAgents = new Set<string>();
  const rows: DeviceRow[] = input.devices.map((device) => {
    const assignments = input.assignments.filter((a) => a.device_id === device.id && a.active);
    const inventory = input.connections.filter((c) => connectionDeviceId(c) === device.id);
    const linkedAgentIds = [
      ...new Set(
        [
          ...assignments.map((a) => a.agent_id),
          ...inventory.filter(isLive).map((c) => c.enrolled_agent_id),
        ].filter((id): id is string => !!id),
      ),
    ];
    linkedAgentIds.forEach((id) => claimedAgents.add(id));

    const people = assignments.flatMap((assignment) => {
      const person = personsById.get(assignment.person_id);
      return person ? [{ assignmentId: assignment.id, person, role: assignment.role }] : [];
    });

    return {
      key: device.id,
      origin: "household",
      deviceId: device.id,
      agentId: linkedAgentIds[0] ?? null,
      label: device.label,
      type: device.device_type,
      people,
      shared: people.length > 1,
      connections: {
        agent: agentConnection(linkedAgentIds, agentsById, inventory),
        dns: summarise("dns", inventory),
        proxy: summarise("proxy", inventory),
      },
    };
  });

  for (const agent of input.agents) {
    if (claimedAgents.has(agent.id)) continue;
    rows.push({
      key: agentDeviceKey(agent.id),
      origin: "unclaimed_agent",
      deviceId: null,
      agentId: agent.id,
      label: agent.name,
      type: "computer",
      people: [],
      shared: false,
      connections: {
        agent: agentConnection([agent.id], agentsById, []),
        dns: none("dns"),
        proxy: none("proxy"),
      },
    });
  }

  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

/** How many of the three connections are reporting right now. */
export function connectedCount(row: DeviceRow): number {
  return CONNECTION_KINDS.filter((kind) => row.connections[kind].state === "connected").length;
}
