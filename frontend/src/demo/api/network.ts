import type { ApiClient } from "@/api";
import type {
  NetworkAgentEnrollment,
  NetworkAssignment,
  NetworkConnection,
  NetworkDevice,
  NetworkGrant,
  NetworkHousehold,
  NetworkPerson,
} from "@/api/types";
import { asRecord } from "./helpers";

const HOUSEHOLD = "hh-demo";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Fake Vantyr Network inventory. In memory, so creating and editing works for the demo session. */
export function demoNetworkApi(): Partial<ApiClient> {
  let counter = 0;
  const id = (prefix: string) => `${prefix}-demo-${++counter}`;

  const households: NetworkHousehold[] = [
    { id: HOUSEHOLD, name: "Home", is_default: true, created_at: ago(60 * 24 * 30) },
  ];
  const persons: NetworkPerson[] = [
    {
      id: "per-alex",
      household_id: HOUSEHOLD,
      display_name: "Alex",
      note: "Parent",
      created_at: ago(60 * 24 * 30),
    },
    {
      id: "per-sam",
      household_id: HOUSEHOLD,
      display_name: "Sam",
      note: "Teenager",
      created_at: ago(60 * 24 * 30),
    },
    {
      id: "per-jo",
      household_id: HOUSEHOLD,
      display_name: "Jo",
      note: "Child",
      created_at: ago(60 * 24 * 30),
    },
  ];
  const devices: NetworkDevice[] = [
    {
      id: "dev-desktop",
      canonical_key: "0a1b2c3d4e5f",
      label: "Desktop",
      device_type: "computer",
      created_at: ago(60 * 24 * 29),
      updated_at: ago(60 * 24),
    },
    {
      id: "dev-laptop",
      canonical_key: "a1b2c3d4e5f6",
      label: "Laptop",
      device_type: "computer",
      created_at: ago(60 * 24 * 29),
      updated_at: ago(60 * 24),
    },
    {
      id: "dev-tv",
      canonical_key: "ff00aa11bb22",
      label: "Living room TV",
      device_type: "tv",
      created_at: ago(60 * 24 * 20),
      updated_at: ago(60 * 24 * 2),
    },
    {
      id: "dev-tablet",
      canonical_key: "c0ffee123456",
      label: "Kitchen tablet",
      device_type: "tablet",
      created_at: ago(60 * 24 * 12),
      updated_at: ago(60 * 24 * 3),
    },
    {
      id: "dev-macbook",
      canonical_key: "b4c5d6e7f809",
      label: "MacBook",
      device_type: "computer",
      created_at: ago(60 * 24 * 10),
      updated_at: ago(60 * 24),
    },
  ];
  const assignments: NetworkAssignment[] = [
    {
      id: "asg-1",
      household_id: HOUSEHOLD,
      person_id: "per-alex",
      device_id: "dev-desktop",
      agent_id: "desktop",
      role: "owner",
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(60 * 24 * 29),
    },
    {
      id: "asg-2",
      household_id: HOUSEHOLD,
      person_id: "per-sam",
      device_id: "dev-desktop",
      agent_id: null,
      role: "member",
      note: null,
      created_at: ago(60 * 24 * 28),
      updated_at: ago(60 * 24 * 28),
    },
    {
      id: "asg-3",
      household_id: HOUSEHOLD,
      person_id: "per-alex",
      device_id: "dev-laptop",
      agent_id: "laptop",
      role: "owner",
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(60 * 24 * 29),
    },
    {
      id: "asg-4",
      household_id: HOUSEHOLD,
      person_id: "per-alex",
      device_id: "dev-tv",
      agent_id: null,
      role: "owner",
      note: "Manages the TV; not who is watching.",
      created_at: ago(60 * 24 * 20),
      updated_at: ago(60 * 24 * 20),
    },
    {
      id: "asg-5",
      household_id: HOUSEHOLD,
      person_id: "per-jo",
      device_id: "dev-tablet",
      agent_id: null,
      role: "member",
      note: null,
      created_at: ago(60 * 24 * 12),
      updated_at: ago(60 * 24 * 12),
    },
    {
      id: "asg-6",
      household_id: HOUSEHOLD,
      person_id: "per-jo",
      device_id: "dev-macbook",
      agent_id: null,
      role: "owner",
      note: "macOS laptop that uses the proxy only.",
      created_at: ago(60 * 24 * 10),
      updated_at: ago(60 * 24 * 10),
    },
  ];
  const connections: NetworkConnection[] = [
    {
      id: "con-1",
      household_id: HOUSEHOLD,
      assignment_id: "asg-1",
      kind: "agent",
      provenance: "agent",
      capabilities: ["verified-user"],
      status: "active",
      observed_at: ago(2),
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(2),
    },
    {
      id: "con-2",
      household_id: HOUSEHOLD,
      assignment_id: "asg-1",
      kind: "dns",
      provenance: "dns",
      capabilities: [],
      status: "active",
      observed_at: ago(1),
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(1),
    },
    {
      id: "con-3",
      household_id: HOUSEHOLD,
      assignment_id: "asg-1",
      kind: "proxy",
      provenance: "proxy",
      capabilities: [],
      status: "active",
      observed_at: ago(2),
      note: null,
      created_at: ago(60 * 24 * 20),
      updated_at: ago(2),
    },
    {
      id: "con-4",
      household_id: HOUSEHOLD,
      assignment_id: "asg-3",
      kind: "agent",
      provenance: "agent",
      capabilities: ["verified-user"],
      status: "active",
      observed_at: ago(3),
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(3),
    },
    {
      id: "con-5",
      household_id: HOUSEHOLD,
      assignment_id: "asg-3",
      kind: "dns",
      provenance: "dns",
      capabilities: [],
      status: "active",
      observed_at: ago(1),
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(1),
    },
    {
      id: "con-6",
      household_id: HOUSEHOLD,
      assignment_id: "asg-4",
      kind: "dns",
      provenance: "dns",
      capabilities: [],
      status: "active",
      observed_at: ago(4),
      note: null,
      created_at: ago(60 * 24 * 20),
      updated_at: ago(4),
    },
    {
      id: "con-7",
      household_id: HOUSEHOLD,
      assignment_id: "asg-5",
      kind: "dns",
      provenance: "dns",
      capabilities: [],
      status: "active",
      observed_at: ago(6),
      note: null,
      created_at: ago(60 * 24 * 12),
      updated_at: ago(6),
    },
    {
      id: "con-8",
      household_id: HOUSEHOLD,
      assignment_id: "asg-6",
      kind: "proxy",
      provenance: "proxy",
      capabilities: [],
      status: "active",
      observed_at: ago(2),
      note: null,
      created_at: ago(60 * 24 * 10),
      updated_at: ago(2),
    },
  ];
  const enrollments: NetworkAgentEnrollment[] = [
    { household_id: HOUSEHOLD, agent_id: "desktop", enrolled_at: ago(60 * 24 * 29) },
    { household_id: HOUSEHOLD, agent_id: "laptop", enrolled_at: ago(60 * 24 * 29) },
  ];
  const grants: NetworkGrant[] = [
    {
      household_id: HOUSEHOLD,
      user_id: "demo-user-admin",
      grant_name: "network_admin",
      granted_at: ago(60 * 24 * 30),
    },
    {
      household_id: HOUSEHOLD,
      user_id: "demo-user-admin",
      grant_name: "network_events",
      granted_at: ago(60 * 24 * 30),
    },
  ];

  const now = () => new Date().toISOString();
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

  return {
    networkHouseholds: async () => ({ households }),
    networkHouseholdCreate: async () => ({ household_id: id("hh") }),
    networkBootstrap: async () => ({ household_id: HOUSEHOLD }),

    networkPersons: async () => ({ persons }),
    networkPersonCreate: async (_household, body) => {
      const b = asRecord(body);
      const created = id("per");
      persons.push({
        id: created,
        household_id: HOUSEHOLD,
        display_name: text(b.display_name),
        note: text(b.note) || null,
        created_at: now(),
      });
      return { id: created };
    },
    networkPersonUpdate: async (_household, personId, body) => {
      const b = asRecord(body);
      const person = persons.find((p) => p.id === personId);
      if (person) {
        if (typeof b.display_name === "string") person.display_name = b.display_name.trim();
        if ("note" in b) person.note = text(b.note) || null;
      }
      return { ok: true };
    },

    networkDevices: async () => ({ devices }),
    networkDeviceCreate: async (_household, body) => {
      const b = asRecord(body);
      const created = id("dev");
      devices.push({
        id: created,
        canonical_key: text(b.canonical_key)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, ""),
        label: text(b.label),
        device_type: (text(b.device_type) || "unknown") as NetworkDevice["device_type"],
        created_at: now(),
        updated_at: now(),
      });
      return { id: created };
    },
    networkDeviceUpdate: async (_household, deviceId, body) => {
      const b = asRecord(body);
      const device = devices.find((d) => d.id === deviceId);
      if (device) {
        if (typeof b.label === "string") device.label = b.label.trim();
        if (typeof b.device_type === "string")
          device.device_type = b.device_type as NetworkDevice["device_type"];
        device.updated_at = now();
      }
      return { ok: true };
    },

    networkAssignments: async () => ({ assignments }),
    networkAssignmentCreate: async (_household, body) => {
      const b = asRecord(body);
      const created = id("asg");
      assignments.push({
        id: created,
        household_id: HOUSEHOLD,
        person_id: text(b.person_id),
        device_id: text(b.device_id),
        agent_id: text(b.agent_id) || null,
        role: (text(b.role) || "member") as NetworkAssignment["role"],
        note: text(b.note) || null,
        created_at: now(),
        updated_at: now(),
      });
      return { id: created };
    },
    networkAssignmentUpdate: async (_household, assignmentId, body) => {
      const b = asRecord(body);
      const assignment = assignments.find((a) => a.id === assignmentId);
      if (assignment) {
        if (typeof b.role === "string") assignment.role = b.role as NetworkAssignment["role"];
        if ("agent_id" in b) assignment.agent_id = text(b.agent_id) || null;
        if ("note" in b) assignment.note = text(b.note) || null;
        assignment.updated_at = now();
      }
      return { ok: true };
    },

    networkConnections: async () => ({ connections }),
    networkConnectionCreate: async () => ({ id: id("con") }),
    networkConnectionUpdate: async () => ({ ok: true }),

    networkAgentEnrollments: async () => ({ enrollments }),
    networkAgentEnroll: async () => ({ ok: true }),

    networkGrants: async () => ({ grants }),
    networkGrantCreate: async () => ({ ok: true, created: true }),
    networkGrantDelete: async () => ({ ok: true }),
  };
}
