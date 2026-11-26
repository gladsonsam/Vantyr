import {
  delJson,
  get,
  limitOffsetQuery,
  patchJson,
  postJsonRes,
  putJson,
} from "@/api/client";
import type {
  NetworkAgentEnrollment,
  NetworkAssignment,
  NetworkAssignmentRole,
  NetworkBinding,
  NetworkDeviceAuthorizationPage,
  NetworkEnrolledDevice,
  NetworkOwnDevice,
  NetworkOwnGrant,
  NetworkOwnSession,
  NetworkSelfDeviceType,
  NetworkSessionEndResult,
  NetworkSetupGrantConsume,
  NetworkSetupGrantIssued,
  NetworkSetupPurpose,
  NetworkVerifiedSession,
  NetworkConnection,
  NetworkConnectionKind,
  NetworkConnectionStatus,
  NetworkDevice,
  NetworkDeviceType,
  NetworkAuditFilters,
  NetworkAuditResponse,
  NetworkEnrollmentContextPage,
  NetworkPolicyDiffResponse,
  NetworkPolicyViewResponse,
  NetworkDesiredPolicy,
  NetworkDeleteResult,
  NetworkGateway,
  NetworkGatewayPatch,
  NetworkGatewayPatchResult,
  NetworkHouseholdPatch,
  NetworkHouseholdPatchResult,
  NetworkInventoryDeleteKind,
  NetworkGatewayCredential,
  NetworkGatewayCredentialIssued,
  NetworkGatewayCredentialRequest,
  NetworkGatewayKind,
  NetworkGatewayReport,
  NetworkGrant,
  NetworkGrantName,
  NetworkHousehold,
  NetworkPageParams,
  NetworkPerson,
  NetworkPolicyDraft,
  NetworkPolicySaved,
  NetworkPolicyVersion,
  NetworkProvenance,
  Patch,
} from "@/api/types";

const base = (household: string) => `/network/households/${household}`;

const INVENTORY_PATH: Record<NetworkInventoryDeleteKind, string> = {
  person: "persons",
  device: "devices",
  assignment: "assignments",
  connection: "connections",
};

/**
 * Vantyr Network inventory: households, people, devices, assignments, connections, agent
 * enrollments and access grants. Access is its own scope (`network_admin` / `network_events`);
 * the dashboard's admin/operator/viewer roles never imply it.
 */
export const networkEndpoints = {
  networkHouseholds: (): Promise<{ households: NetworkHousehold[] }> =>
    get("/network/households"),
  networkHouseholdCreate: (body: {
    name: string;
    timezone?: string;
  }): Promise<{ household_id: string }> =>
    postJsonRes("/network/households", body),
  /** Admin-only, audited, one-time: creates the first household and its first grant. */
  networkBootstrap: (body: {
    name: string;
    timezone?: string;
  }): Promise<{ household_id: string }> =>
    postJsonRes("/network/bootstrap", body),

  networkHouseholdUpdate: (
    household: string,
    body: NetworkHouseholdPatch,
  ): Promise<NetworkHouseholdPatchResult> =>
    patchJson(base(household), body),

  networkPersons: (household: string): Promise<{ persons: NetworkPerson[] }> =>
    get(`${base(household)}/persons`),
  networkPersonCreate: (
    household: string,
    body: { display_name: string; note?: string; is_default_profile?: boolean },
  ): Promise<{ id: string }> => postJsonRes(`${base(household)}/persons`, body),
  networkPersonUpdate: (
    household: string,
    id: string,
    body: {
      display_name?: string;
      note?: Patch<string>;
      is_default_profile?: boolean;
    },
  ): Promise<{ ok: boolean }> =>
    patchJson(`${base(household)}/persons/${id}`, body),

  networkDevices: (household: string): Promise<{ devices: NetworkDevice[] }> =>
    get(`${base(household)}/devices`),
  networkDeviceCreate: (
    household: string,
    body: {
      canonical_key: string;
      label: string;
      device_type?: NetworkDeviceType;
      shared?: boolean;
    },
  ): Promise<{ id: string }> => postJsonRes(`${base(household)}/devices`, body),
  networkDeviceUpdate: (
    household: string,
    id: string,
    body: { label?: string; device_type?: NetworkDeviceType; shared?: boolean },
  ): Promise<{ ok: boolean }> =>
    patchJson(`${base(household)}/devices/${id}`, body),

  networkAssignments: (
    household: string,
  ): Promise<{ assignments: NetworkAssignment[] }> =>
    get(`${base(household)}/assignments`),
  networkAssignmentCreate: (
    household: string,
    body: {
      person_id: string;
      device_id: string;
      agent_id?: string;
      role?: NetworkAssignmentRole;
      active?: boolean;
      note?: string;
    },
  ): Promise<{ id: string }> =>
    postJsonRes(`${base(household)}/assignments`, body),
  networkAssignmentUpdate: (
    household: string,
    id: string,
    body: {
      agent_id?: Patch<string>;
      role?: NetworkAssignmentRole;
      active?: boolean;
      note?: Patch<string>;
    },
  ): Promise<{ ok: boolean }> =>
    patchJson(`${base(household)}/assignments/${id}`, body),

  networkConnections: (
    household: string,
  ): Promise<{ connections: NetworkConnection[] }> =>
    get(`${base(household)}/connections`),
  networkConnectionCreate: (
    household: string,
    body: {
      /** The device the connection is about (household-owned). No person is required. */
      device_id: string;
      assignment_id?: string;
      enrolled_agent_id?: string;
      kind: NetworkConnectionKind;
      provenance?: NetworkProvenance;
      capabilities?: string[];
      status?: NetworkConnectionStatus;
      observed_at?: string;
      last_seen_at?: string;
      revoked_at?: string;
      note?: string;
    },
  ): Promise<{ id: string }> =>
    postJsonRes(`${base(household)}/connections`, body),
  networkConnectionUpdate: (
    household: string,
    id: string,
    body: {
      assignment_id?: Patch<string>;
      enrolled_agent_id?: Patch<string>;
      provenance?: NetworkProvenance;
      capabilities?: string[];
      status?: NetworkConnectionStatus;
      observed_at?: Patch<string>;
      last_seen_at?: Patch<string>;
      revoked_at?: Patch<string>;
      note?: Patch<string>;
    },
  ): Promise<{ ok: boolean }> =>
    patchJson(`${base(household)}/connections/${id}`, body),

  /** Conservative: 409 while anything references the row. Deletes the inventory record only. */
  networkInventoryDelete: (
    household: string,
    kind: NetworkInventoryDeleteKind,
    id: string,
  ): Promise<NetworkDeleteResult> =>
    delJson(`${base(household)}/${INVENTORY_PATH[kind]}/${id}`),

  networkAgentEnrollments: (
    household: string,
  ): Promise<{ enrollments: NetworkAgentEnrollment[] }> =>
    get(`${base(household)}/agent-enrollments`),
  networkAgentEnroll: (
    household: string,
    body: { agent_id: string },
  ): Promise<{ ok: boolean }> =>
    postJsonRes(`${base(household)}/agent-enrollments`, body),

  networkGrants: (household: string): Promise<{ grants: NetworkGrant[] }> =>
    get(`${base(household)}/grants`),
  networkGrantCreate: (
    household: string,
    body: { user_id: string; grant: NetworkGrantName },
  ): Promise<{ ok: boolean; created: boolean }> =>
    postJsonRes(`${base(household)}/grants`, body),
  networkGrantDelete: (
    household: string,
    userId: string,
    grant: NetworkGrantName,
  ): Promise<{ ok: boolean }> =>
    delJson(`${base(household)}/grants/${userId}/${grant}`),

  // ─── Household audit (network_admin; newest first; exact-match filters) ──────
  networkAudit: (
    household: string,
    filters?: NetworkAuditFilters,
  ): Promise<NetworkAuditResponse> => {
    const q = new URLSearchParams(limitOffsetQuery(filters).slice(1));
    for (const key of ["action", "actor", "from", "to"] as const) {
      const value = filters?.[key];
      if (value) q.set(key, value);
    }
    const qs = q.toString();
    return get(`${base(household)}/audit${qs ? `?${qs}` : ""}`);
  },

  // ─── Gateways: DNS / Proxy workers and their scoped credentials ──────────────
  networkGateways: (
    household: string,
    params?: NetworkPageParams & { kind?: NetworkGatewayKind },
  ): Promise<{ gateways: NetworkGateway[] }> => {
    const q = new URLSearchParams(limitOffsetQuery(params).slice(1));
    if (params?.kind) q.set("kind", params.kind);
    const qs = q.toString();
    return get(`${base(household)}/gateways${qs ? `?${qs}` : ""}`);
  },
  networkGatewayCreate: (
    household: string,
    body: { kind: NetworkGatewayKind; label: string },
  ): Promise<{ id: string }> =>
    postJsonRes(`${base(household)}/gateways`, body),
  networkGatewayUpdate: (
    household: string,
    gateway: string,
    body: NetworkGatewayPatch,
  ): Promise<NetworkGatewayPatchResult> =>
    patchJson(`${base(household)}/gateways/${gateway}`, body),
  networkGatewayRevoke: (
    household: string,
    gateway: string,
  ): Promise<{ ok: boolean }> =>
    delJson(`${base(household)}/gateways/${gateway}`),
  networkGatewayCredentials: (
    household: string,
    gateway: string,
    page?: NetworkPageParams,
  ): Promise<{ credentials: NetworkGatewayCredential[] }> =>
    get(
      `${base(household)}/gateways/${gateway}/credentials${limitOffsetQuery(page)}`,
    ),
  /** The returned `token` is shown once; it cannot be fetched again. */
  networkGatewayCredentialIssue: (
    household: string,
    gateway: string,
    body: NetworkGatewayCredentialRequest,
  ): Promise<NetworkGatewayCredentialIssued> =>
    postJsonRes(`${base(household)}/gateways/${gateway}/credentials`, body),
  networkGatewayCredentialRotate: (
    household: string,
    gateway: string,
    credential: string,
    body: NetworkGatewayCredentialRequest,
  ): Promise<NetworkGatewayCredentialIssued> =>
    postJsonRes(
      `${base(household)}/gateways/${gateway}/credentials/${credential}/rotate`,
      body,
    ),
  networkGatewayCredentialRevoke: (
    household: string,
    gateway: string,
    credential: string,
  ): Promise<{ ok: boolean }> =>
    delJson(`${base(household)}/gateways/${gateway}/credentials/${credential}`),
  /** Heartbeat reports, newest first. Unverified observations, never proof of enforcement. */
  networkGatewayReports: (
    household: string,
    gateway: string,
    page?: NetworkPageParams,
  ): Promise<{ reports: NetworkGatewayReport[] }> =>
    get(
      `${base(household)}/gateways/${gateway}/reports${limitOffsetQuery(page)}`,
    ),

  // ─── Versioned policy (saved proposals only) and desired assignment ──────────
  networkPolicies: (
    household: string,
    page?: NetworkPageParams,
  ): Promise<{ policies: NetworkPolicyVersion[]; count: number }> =>
    get(`${base(household)}/policies${limitOffsetQuery(page)}`),
  /** Highest stored revision (not the desired, applied or verified one). network_admin. */
  networkPolicyCurrent: (household: string): Promise<NetworkPolicyViewResponse> =>
    get(`${base(household)}/policies/current`),
  /** 400 malformed, 404 missing, pruned or foreign. */
  networkPolicyRevision: (
    household: string,
    revision: number,
  ): Promise<NetworkPolicyViewResponse> =>
    get(`${base(household)}/policies/${revision}`),
  networkPolicyDiff: (
    household: string,
    fromRevision: number,
    toRevision: number,
  ): Promise<NetworkPolicyDiffResponse> =>
    get(
      `${base(household)}/policies/diff?from_revision=${fromRevision}&to_revision=${toRevision}`,
    ),
  networkPolicyPublish: (
    household: string,
    body: NetworkPolicyDraft,
  ): Promise<NetworkPolicySaved> =>
    postJsonRes(`${base(household)}/policies`, body),
  /** Copies a historical revision into a new saved revision. */
  networkPolicyRollback: (
    household: string,
    body: { source_revision: number; expected_revision?: number },
  ): Promise<NetworkPolicySaved> =>
    postJsonRes(`${base(household)}/policies/rollback`, body),
  networkGatewayDesiredPolicy: (
    household: string,
    gateway: string,
  ): Promise<{ desired: NetworkDesiredPolicy | null }> =>
    get(`${base(household)}/gateways/${gateway}/desired-policy`),
  networkGatewayDesiredPolicySet: (
    household: string,
    gateway: string,
    body: { revision: number },
  ): Promise<{ desired: NetworkDesiredPolicy }> =>
    putJson(`${base(household)}/gateways/${gateway}/desired-policy`, body),

  // ─── BYOD: principal bindings and device authorizations (network_admin) ─────
  networkBindings: (
    household: string,
  ): Promise<{ bindings: NetworkBinding[] }> =>
    get(`${base(household)}/bindings`),
  networkBindingCreate: (
    household: string,
    body: { person_id: string; user_id: string },
  ): Promise<{ ok: boolean; binding_id: string }> =>
    postJsonRes(`${base(household)}/bindings`, body),
  /** Invalidates the person's enrolled devices, grants and sessions. */
  networkBindingDelete: (
    household: string,
    binding: string,
  ): Promise<{ ok: boolean }> =>
    delJson(`${base(household)}/bindings/${binding}`),
  networkDeviceAuthorizations: (
    household: string,
    binding: string,
    page?: NetworkPageParams,
  ): Promise<NetworkDeviceAuthorizationPage> =>
    get(
      `${base(household)}/bindings/${binding}/device-authorizations${limitOffsetQuery(page)}`,
    ),
  networkDeviceAuthorize: (
    household: string,
    binding: string,
    body: { device_id: string },
  ): Promise<{ ok: boolean; enrollment_id: string }> =>
    postJsonRes(
      `${base(household)}/bindings/${binding}/device-authorizations`,
      body,
    ),

  // ─── BYOD self-service (network_enroll + an active binding) ──────────────────
  networkOwnDevices: (
    household: string,
  ): Promise<{ devices: NetworkOwnDevice[] }> =>
    get(`${base(household)}/enroll/devices`),
  networkOwnDeviceRegister: (
    household: string,
    body: { label: string; device_type: NetworkSelfDeviceType; shared?: boolean },
  ): Promise<NetworkEnrolledDevice> =>
    postJsonRes(`${base(household)}/enroll/devices`, body),
  networkOwnDeviceEnd: (
    household: string,
    device: string,
  ): Promise<{ ok: boolean }> =>
    delJson(`${base(household)}/enroll/devices/${device}`),
  networkOwnGrants: (
    household: string,
  ): Promise<{ grants: NetworkOwnGrant[] }> =>
    get(`${base(household)}/enroll/grants`),
  /** The returned `secret` is shown once; it cannot be fetched again. */
  networkSetupGrantIssue: (
    household: string,
    body: {
      device_id: string;
      purpose: NetworkSetupPurpose;
      expires_in_secs: number;
    },
  ): Promise<NetworkSetupGrantIssued> =>
    postJsonRes(`${base(household)}/enroll/grants`, body),
  networkSetupGrantConsume: (
    household: string,
    body: NetworkSetupGrantConsume,
  ): Promise<NetworkVerifiedSession> =>
    postJsonRes(`${base(household)}/enroll/grants/consume`, body),
  networkOwnSessions: (
    household: string,
  ): Promise<{ sessions: NetworkOwnSession[] }> =>
    get(`${base(household)}/enroll/sessions`),
  /** Network sign-out only: it does not end the dashboard session. */
  networkOwnSessionsEndAll: (
    household: string,
  ): Promise<NetworkSessionEndResult & { ended: number }> =>
    delJson(`${base(household)}/enroll/sessions`),
  networkOwnSessionEnd: (
    household: string,
    session: string,
  ): Promise<NetworkSessionEndResult> =>
    delJson(`${base(household)}/enroll/sessions/${session}`),

  // ─── Enrollment contexts: households and people the signed-in user is bound to ─
  networkEnrollmentContexts: (
    page?: NetworkPageParams,
  ): Promise<NetworkEnrollmentContextPage> =>
    get(`/network/enrollment-contexts${limitOffsetQuery(page)}`),
};
