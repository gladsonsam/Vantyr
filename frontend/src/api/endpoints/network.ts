import { delJson, get, patchJson, postJsonRes } from "@/api/client";
import type {
  NetworkAgentEnrollment,
  NetworkAssignment,
  NetworkAssignmentRole,
  NetworkConnection,
  NetworkConnectionKind,
  NetworkConnectionStatus,
  NetworkDevice,
  NetworkDeviceType,
  NetworkGrant,
  NetworkGrantName,
  NetworkHousehold,
  NetworkPerson,
  NetworkProvenance,
  Patch,
} from "@/api/types";

const base = (household: string) => `/network/households/${household}`;

/**
 * Vantyr Network inventory: households, people, devices, assignments, connections, agent
 * enrollments and access grants. Access is its own scope (`network_admin` / `network_events`);
 * the dashboard's admin/operator/viewer roles never imply it.
 */
export const networkEndpoints = {
  networkHouseholds: (): Promise<{ households: NetworkHousehold[] }> => get("/network/households"),
  networkHouseholdCreate: (body: { name: string }): Promise<{ household_id: string }> =>
    postJsonRes("/network/households", body),
  /** Admin-only, audited, one-time: creates the first household and its first grant. */
  networkBootstrap: (body: { name: string }): Promise<{ household_id: string }> =>
    postJsonRes("/network/bootstrap", body),

  networkPersons: (household: string): Promise<{ persons: NetworkPerson[] }> =>
    get(`${base(household)}/persons`),
  networkPersonCreate: (
    household: string,
    body: { display_name: string; note?: string },
  ): Promise<{ id: string }> => postJsonRes(`${base(household)}/persons`, body),
  networkPersonUpdate: (
    household: string,
    id: string,
    body: { display_name?: string; note?: Patch<string> },
  ): Promise<{ ok: boolean }> => patchJson(`${base(household)}/persons/${id}`, body),

  networkDevices: (household: string): Promise<{ devices: NetworkDevice[] }> =>
    get(`${base(household)}/devices`),
  networkDeviceCreate: (
    household: string,
    body: { canonical_key: string; label: string; device_type?: NetworkDeviceType },
  ): Promise<{ id: string }> => postJsonRes(`${base(household)}/devices`, body),
  networkDeviceUpdate: (
    household: string,
    id: string,
    body: { label?: string; device_type?: NetworkDeviceType },
  ): Promise<{ ok: boolean }> => patchJson(`${base(household)}/devices/${id}`, body),

  networkAssignments: (household: string): Promise<{ assignments: NetworkAssignment[] }> =>
    get(`${base(household)}/assignments`),
  networkAssignmentCreate: (
    household: string,
    body: {
      person_id: string;
      device_id: string;
      agent_id?: string;
      role?: NetworkAssignmentRole;
      note?: string;
    },
  ): Promise<{ id: string }> => postJsonRes(`${base(household)}/assignments`, body),
  networkAssignmentUpdate: (
    household: string,
    id: string,
    body: { agent_id?: Patch<string>; role?: NetworkAssignmentRole; note?: Patch<string> },
  ): Promise<{ ok: boolean }> => patchJson(`${base(household)}/assignments/${id}`, body),

  networkConnections: (household: string): Promise<{ connections: NetworkConnection[] }> =>
    get(`${base(household)}/connections`),
  networkConnectionCreate: (
    household: string,
    body: {
      assignment_id: string;
      kind: NetworkConnectionKind;
      provenance?: NetworkProvenance;
      capabilities?: string[];
      status?: NetworkConnectionStatus;
      observed_at?: string;
      note?: string;
    },
  ): Promise<{ id: string }> => postJsonRes(`${base(household)}/connections`, body),
  networkConnectionUpdate: (
    household: string,
    id: string,
    body: {
      provenance?: NetworkProvenance;
      capabilities?: string[];
      status?: NetworkConnectionStatus;
      observed_at?: Patch<string>;
      note?: Patch<string>;
    },
  ): Promise<{ ok: boolean }> => patchJson(`${base(household)}/connections/${id}`, body),

  networkAgentEnrollments: (
    household: string,
  ): Promise<{ enrollments: NetworkAgentEnrollment[] }> =>
    get(`${base(household)}/agent-enrollments`),
  networkAgentEnroll: (household: string, body: { agent_id: string }): Promise<{ ok: boolean }> =>
    postJsonRes(`${base(household)}/agent-enrollments`, body),

  networkGrants: (household: string): Promise<{ grants: NetworkGrant[] }> =>
    get(`${base(household)}/grants`),
  networkGrantCreate: (
    household: string,
    body: { user_id: string; grant: NetworkGrantName },
  ): Promise<{ ok: boolean; created: boolean }> => postJsonRes(`${base(household)}/grants`, body),
  networkGrantDelete: (
    household: string,
    userId: string,
    grant: NetworkGrantName,
  ): Promise<{ ok: boolean }> => delJson(`${base(household)}/grants/${userId}/${grant}`),
};
