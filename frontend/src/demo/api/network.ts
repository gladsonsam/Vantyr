import { ApiError, type ApiClient } from "@/api";
import type {
  NetworkAgentEnrollment,
  NetworkAssignment,
  NetworkAuditRow,
  NetworkAuditResponse,
  NetworkEnrollmentContextPage,
  NetworkPolicyBody,
  NetworkPolicyDiff,
  NetworkPolicyDiffResponse,
  NetworkPolicyRule,
  NetworkPolicyRuleChange,
  NetworkPolicySettingChange,
  NetworkPolicyView,
  NetworkPolicyViewResponse,
  NetworkPolicyDraft,
  NetworkBinding,
  NetworkDeviceAuthorization,
  NetworkGrantName,
  NetworkOwnDevice,
  NetworkOwnGrant,
  NetworkOwnSession,
  NetworkSetupPurpose,
  NetworkConnection,
  NetworkDesiredPolicy,
  NetworkDevice,
  NetworkGateway,
  NetworkGatewayCredential,
  NetworkGatewayReport,
  NetworkGrant,
  NetworkHousehold,
  NetworkPerson,
  NetworkPolicyVersion,
} from "@/api/types";
import { asRecord, page } from "./helpers";

const HOUSEHOLD = "hh-demo";
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** Fake Vantyr Network inventory. In memory, so creating and editing works for the demo session. */
export function demoNetworkApi(): Partial<ApiClient> {
  let counter = 0;
  const id = (prefix: string) => `${prefix}-demo-${++counter}`;

  const households: NetworkHousehold[] = [
    {
      id: HOUSEHOLD,
      name: "Home",
      timezone: "UTC",
      is_default: true,
      created_at: ago(60 * 24 * 30),
    },
  ];
  const persons: NetworkPerson[] = [
    {
      id: "per-alex",
      household_id: HOUSEHOLD,
      display_name: "Alex",
      is_default_profile: false,
      note: "Parent",
      created_at: ago(60 * 24 * 30),
    },
    {
      id: "per-sam",
      household_id: HOUSEHOLD,
      display_name: "Sam",
      is_default_profile: false,
      note: "Teenager",
      created_at: ago(60 * 24 * 30),
    },
    {
      id: "per-jo",
      household_id: HOUSEHOLD,
      display_name: "Jo",
      is_default_profile: false,
      note: "Child",
      created_at: ago(60 * 24 * 30),
    },
  ];
  const devices: NetworkDevice[] = [
    {
      id: "dev-desktop",
      household_id: HOUSEHOLD,
      canonical_key: "0a1b2c3d4e5f",
      label: "Desktop",
      device_type: "computer",
      shared: false,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(60 * 24),
    },
    {
      id: "dev-laptop",
      household_id: HOUSEHOLD,
      canonical_key: "a1b2c3d4e5f6",
      label: "Laptop",
      device_type: "computer",
      shared: false,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(60 * 24),
    },
    {
      id: "dev-tv",
      household_id: HOUSEHOLD,
      canonical_key: "ff00aa11bb22",
      label: "Living room TV",
      device_type: "tv",
      shared: false,
      created_at: ago(60 * 24 * 20),
      updated_at: ago(60 * 24 * 2),
    },
    {
      id: "dev-tablet",
      household_id: HOUSEHOLD,
      canonical_key: "c0ffee123456",
      label: "Kitchen tablet",
      device_type: "tablet",
      shared: false,
      created_at: ago(60 * 24 * 12),
      updated_at: ago(60 * 24 * 3),
    },
    {
      id: "dev-macbook",
      household_id: HOUSEHOLD,
      canonical_key: "b4c5d6e7f809",
      label: "MacBook",
      device_type: "computer",
      shared: false,
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
      active: true,
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
      active: true,
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
      active: true,
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
      active: true,
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
      active: true,
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
      active: true,
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
      device_id: "dev-desktop",
      assignment_id: "asg-1",
      enrolled_agent_id: "desktop",
      kind: "agent",
      provenance: "agent",
      capabilities: ["verified-user"],
      status: "active",
      observed_at: ago(2),
      last_seen_at: ago(2),
      revoked_at: null,
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(2),
    },
    {
      id: "con-2",
      household_id: HOUSEHOLD,
      device_id: "dev-desktop",
      assignment_id: "asg-1",
      enrolled_agent_id: null,
      kind: "dns",
      provenance: "dns",
      capabilities: [],
      status: "active",
      observed_at: ago(1),
      last_seen_at: ago(1),
      revoked_at: null,
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(1),
    },
    {
      id: "con-3",
      household_id: HOUSEHOLD,
      device_id: "dev-desktop",
      assignment_id: "asg-1",
      enrolled_agent_id: null,
      kind: "proxy",
      provenance: "proxy",
      capabilities: [],
      status: "active",
      observed_at: ago(2),
      last_seen_at: ago(2),
      revoked_at: null,
      note: null,
      created_at: ago(60 * 24 * 20),
      updated_at: ago(2),
    },
    {
      id: "con-4",
      household_id: HOUSEHOLD,
      device_id: "dev-laptop",
      assignment_id: "asg-3",
      enrolled_agent_id: "laptop",
      kind: "agent",
      provenance: "agent",
      capabilities: ["verified-user"],
      status: "active",
      observed_at: ago(3),
      last_seen_at: ago(3),
      revoked_at: null,
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(3),
    },
    {
      id: "con-5",
      household_id: HOUSEHOLD,
      device_id: "dev-laptop",
      assignment_id: "asg-3",
      enrolled_agent_id: null,
      kind: "dns",
      provenance: "dns",
      capabilities: [],
      status: "active",
      observed_at: ago(1),
      last_seen_at: ago(1),
      revoked_at: null,
      note: null,
      created_at: ago(60 * 24 * 29),
      updated_at: ago(1),
    },
    {
      id: "con-6",
      household_id: HOUSEHOLD,
      device_id: "dev-tv",
      assignment_id: "asg-4",
      enrolled_agent_id: null,
      kind: "dns",
      provenance: "dns",
      capabilities: [],
      status: "active",
      observed_at: ago(4),
      last_seen_at: ago(4),
      revoked_at: null,
      note: null,
      created_at: ago(60 * 24 * 20),
      updated_at: ago(4),
    },
    {
      id: "con-7",
      household_id: HOUSEHOLD,
      device_id: "dev-tablet",
      assignment_id: "asg-5",
      enrolled_agent_id: null,
      kind: "dns",
      provenance: "dns",
      capabilities: [],
      status: "active",
      observed_at: ago(6),
      last_seen_at: ago(6),
      revoked_at: null,
      note: null,
      created_at: ago(60 * 24 * 12),
      updated_at: ago(6),
    },
    {
      id: "con-8",
      household_id: HOUSEHOLD,
      device_id: "dev-macbook",
      assignment_id: "asg-6",
      enrolled_agent_id: null,
      kind: "proxy",
      provenance: "proxy",
      capabilities: [],
      status: "active",
      observed_at: ago(2),
      last_seen_at: ago(2),
      revoked_at: null,
      note: null,
      created_at: ago(60 * 24 * 10),
      updated_at: ago(2),
    },
  ];
  const enrollments: NetworkAgentEnrollment[] = [
    {
      household_id: HOUSEHOLD,
      agent_id: "desktop",
      enrolled_at: ago(60 * 24 * 29),
    },
    {
      household_id: HOUSEHOLD,
      agent_id: "laptop",
      enrolled_at: ago(60 * 24 * 29),
    },
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
    {
      household_id: HOUSEHOLD,
      user_id: "demo-user-admin",
      grant_name: "network_enroll",
      granted_at: ago(60 * 24 * 7),
    },
  ];

  // ─── BYOD: one binding (Jo <-> the demo user), one self-enrolled device, sessions ────────────
  const DEMO_USER = "demo-user-admin";
  const bindings: NetworkBinding[] = [
    {
      id: "bnd-jo",
      dashboard_user: DEMO_USER,
      person_id: "per-jo",
      generation: 1,
      active: true,
      created_at: ago(60 * 24 * 7),
      revoked_at: null,
      dashboard_username: "admin",
      dashboard_display_name: "Demo Admin",
      person_display_name: "Jo",
    },
  ];
  const deviceAuths: NetworkDeviceAuthorization[] = [
    {
      id: "enr-tablet",
      binding_id: "bnd-jo",
      device_id: "dev-tablet",
      generation: 1,
      status: "enrolled",
      authorized_by: DEMO_USER,
      created_at: ago(60 * 24 * 6),
    },
  ];
  const ownDevices: NetworkOwnDevice[] = [
    {
      id: "dev-tablet",
      label: "Kitchen tablet",
      device_type: "tablet",
      shared: true,
      enrollment_id: "enr-tablet",
      enrollment_status: "enrolled",
    },
    {
      id: "dev-jo-phone",
      label: "Jo’s phone",
      device_type: "phone",
      shared: false,
      enrollment_id: "enr-phone",
      enrollment_status: "enrolled",
    },
  ];
  const ownGrants: NetworkOwnGrant[] = [];
  const grantSecrets = new Map<string, string>();
  const ownSessions: NetworkOwnSession[] = [
    {
      id: "ses-demo-1",
      device_id: "dev-jo-phone",
      purpose: "proxy_setup",
      verification_method: "oidc_session",
      verified_at: ago(90),
      expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
      ended_at: null,
      person_display_name: "Jo",
    },
  ];
  const activeBinding = () =>
    bindings.find((b) => b.active && b.dashboard_user === DEMO_USER);
  const requireBinding = () => {
    const binding = activeBinding();
    if (!binding)
      throw new ApiError(
        "You don’t have BYOD enrollment for this household. Ask an administrator.",
        403,
      );
    return binding;
  };
  const randomSecret = () =>
    Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  const endSessionsOf = (deviceId?: string) => {
    let n = 0;
    for (const x of ownSessions)
      if (!x.ended_at && (!deviceId || x.device_id === deviceId)) {
        x.ended_at = new Date().toISOString();
        n++;
      }
    let g = 0;
    for (const x of ownGrants)
      if (!x.revoked_at && !x.consumed_at && (!deviceId || x.device_id === deviceId)) {
        x.revoked_at = new Date().toISOString();
        g++;
      }
    return { ended: n, grants: g };
  };

  // Gateway: online, reporting capabilities and a REPORTED applied revision r14 while desired is r15.
  // The reported value is an unverified worker observation, matching the demo policy (r14 applied,
  // r15 saved proposal) in demoNetworkRuntime.
  const GATEWAY = "gw-demo-dns";
  const gateways: NetworkGateway[] = [
    {
      id: GATEWAY,
      household_id: HOUSEHOLD,
      kind: "dns",
      label: "Home DNS",
      enabled: true,
      capabilities: ["dns", "heartbeat", "config-read"],
      last_seen_at: ago(1),
      revoked_at: null,
      created_at: ago(60 * 24 * 20),
      updated_at: ago(1),
    },
  ];
  const credentials: NetworkGatewayCredential[] = [
    {
      id: "cred-demo-1",
      household_id: HOUSEHOLD,
      gateway_id: GATEWAY,
      kind: "dns",
      audience: "vantyr-gateway-worker",
      allowed_commands: ["heartbeat", "read_policy"],
      expires_at: new Date(Date.now() + 18 * 24 * 3_600_000).toISOString(),
      revoked_at: null,
      last_used_at: ago(1),
      issued_at: ago(60 * 24 * 12),
      rotated_from: "cred-demo-0",
    },
    {
      id: "cred-demo-0",
      household_id: HOUSEHOLD,
      gateway_id: GATEWAY,
      kind: "dns",
      audience: "vantyr-gateway-worker",
      allowed_commands: ["heartbeat"],
      expires_at: ago(60 * 24 * 2),
      revoked_at: ago(60 * 24 * 12),
      last_used_at: ago(60 * 24 * 12),
      issued_at: ago(60 * 24 * 20),
      rotated_from: null,
    },
  ];
  const reports: NetworkGatewayReport[] = [1, 6, 11, 16].map((minutes, i) => ({
    id: 4 - i,
    household_id: HOUSEHOLD,
    gateway_id: GATEWAY,
    credential_id: "cred-demo-1",
    reported_at: ago(minutes),
    observed_at: ago(minutes),
    capabilities: ["dns", "heartbeat", "config-read"],
    desired_revision: "r15",
    applied_revision: "r14",
    failure: null,
    verified: false,
    enforced: false,
  }));
  let desired: NetworkDesiredPolicy | null = {
    household_id: HOUSEHOLD,
    gateway_id: GATEWAY,
    kind: "dns",
    revision: 15,
    assigned_by: "demo-user-admin",
    assigned_at: ago(45),
  };
  const policyMeta = (
    revision: number,
    minutes: number,
    rolledBack: number | null = null,
  ): NetworkPolicyVersion => ({
    household_id: HOUSEHOLD,
    revision,
    schema_version: 1,
    source_kind: rolledBack ? "rollback" : "publish",
    rolled_back_from_revision: rolledBack,
    published_at: ago(minutes),
    published_by: "demo-user-admin",
    body_sha256:
      `${revision.toString(16).padStart(2, "0")}c4e1a9d07b3f5826ad94e0b17c53f8a2d6e91b40c7a35f8d2e6b1094a7c3d5e8`.slice(
        0,
        64,
      ),
    body_bytes: 1800 + revision * 37,
  });
  const policies: NetworkPolicyVersion[] = [
    policyMeta(15, 45),
    policyMeta(14, 60 * 24 * 3),
    policyMeta(13, 60 * 24 * 9),
  ];
  // Demo policy bodies. r13 baseline malware+phishing; r14 adds two device profiles; r15 adds a
  // baseline chat block. Content only: metadata comes from `policies`.
  const demoRule = (
    ruleId: string,
    domain: string,
    reason: string,
  ): NetworkPolicyRule => ({
    id: ruleId,
    effect: "deny",
    matcher: { domain_suffix: domain },
    schedule: null,
    reason,
  });
  const r13Baseline = [
    demoRule("block-malware", "malware.example", "Known malware"),
    demoRule("block-phishing", "phishing.example", "Known phishing"),
  ];
  const r14Profiles: Record<string, NetworkPolicyRule[]> = {
    "Living room TV": [demoRule("tv-mature", "mature.example", "Not for the living room")],
    "Kitchen tablet": [demoRule("tablet-social", "social.example", "No social media on the tablet")],
  };
  const policyBodies = new Map<number, NetworkPolicyBody>();
  const setBody = (
    revision: number,
    minutes: number,
    baseline: NetworkPolicyRule[],
    device_profiles: Record<string, NetworkPolicyRule[]>,
  ) =>
    policyBodies.set(revision, {
      household_id: HOUSEHOLD,
      revision,
      baseline,
      device_profiles,
      person_rules: {},
      exceptions: [],
      default_effect: "deny",
      timezone: "UTC",
      stale_after_secs: 3600,
      event_retention_secs: 14 * 86400,
      published_at: ago(minutes),
    });
  setBody(13, 60 * 24 * 9, r13Baseline, {});
  setBody(14, 60 * 24 * 3, r13Baseline, r14Profiles);
  setBody(
    15,
    45,
    [...r13Baseline, demoRule("block-chat", "chat.example", "Unmoderated chat")],
    r14Profiles,
  );
  const policyView = (revision: number): NetworkPolicyView => {
    const meta = policies.find((p) => p.revision === revision);
    const body = policyBodies.get(revision);
    if (!meta || !body) throw new ApiError("policy revision is not readable in this household", 404);
    return { ...meta, policy: { ...body, published_at: meta.published_at } };
  };
  const checkRevision = (value: unknown): number => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 1) throw new ApiError("revision must be a positive integer", 400);
    return n;
  };
  const provenance = (view: NetworkPolicyView) => ({
    revision: view.revision,
    schema_version: view.schema_version,
    source_kind: view.source_kind,
    rolled_back_from_revision: view.rolled_back_from_revision,
    published_at: view.published_at,
    body_sha256: view.body_sha256,
  });
  const buildDiff = (from: NetworkPolicyView, to: NetworkPolicyView): NetworkPolicyDiff => {
    const a = from.policy;
    const b = to.policy;
    const settings: NetworkPolicySettingChange[] = [];
    const compare = (field: string, before: unknown, after: unknown) => {
      if (JSON.stringify(before) !== JSON.stringify(after)) settings.push({ field, before, after });
    };
    compare("default_effect", a.default_effect, b.default_effect);
    compare("timezone", a.timezone, b.timezone);
    compare("stale_after_secs", a.stale_after_secs, b.stale_after_secs);
    compare("event_retention_secs", a.event_retention_secs, b.event_retention_secs);
    compare("device_profile_ids", Object.keys(a.device_profiles).sort(), Object.keys(b.device_profiles).sort());
    compare("person_rules", a.person_rules, b.person_rules);
    compare("exceptions", a.exceptions, b.exceptions);
    const index = (p: NetworkPolicyBody) => {
      const out = new Map<string, NetworkPolicyRule>();
      p.baseline.forEach((r) => out.set(`baseline\u0000${r.id}`, r));
      for (const [name, rules] of Object.entries(p.device_profiles))
        rules.forEach((r) => out.set(`profile:${name}\u0000${r.id}`, r));
      return out;
    };
    const before = index(a);
    const after = index(b);
    const rules: NetworkPolicyRuleChange[] = [];
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const [scope = "", ruleId = ""] = key.split("\u0000");
      const x = before.get(key) ?? null;
      const y = after.get(key) ?? null;
      if (x && !y) rules.push({ scope, id: ruleId, change: "removed", before: x, after: null });
      else if (!x && y) rules.push({ scope, id: ruleId, change: "added", before: null, after: y });
      else if (JSON.stringify(x) !== JSON.stringify(y))
        rules.push({ scope, id: ruleId, change: "changed", before: x, after: y });
    }
    const count = (kind: string) => rules.filter((r) => r.change === kind).length;
    return {
      household_id: HOUSEHOLD,
      from: provenance(from),
      to: provenance(to),
      content_changed: settings.length > 0 || rules.length > 0,
      settings,
      rules,
      counts: {
        added_rules: count("added"),
        removed_rules: count("removed"),
        changed_rules: count("changed"),
        changed_settings: settings.length,
        total_rules_from: before.size,
        total_rules_to: after.size,
      },
      truncated: false,
      omitted_changes: 0,
    };
  };
  const extraAudit: [string, number, string, string, Record<string, unknown>][] = [
    ["network_binding_create", 60 * 24 * 7, "demo-user-admin", "ok", { person_id: "per-jo" }],
    ["network_device_enroll", 60 * 24 * 6, "demo-user-jo", "ok", { device_id: "dev-tablet" }],
    ["network_setup_grant_issue", 60 * 24 * 2, "demo-user-jo", "ok", { purpose: "proxy_setup" }],
    ["network_setup_grant_consume", 60 * 24 * 2 - 5, "demo-user-jo", "denied", { purpose: "proxy_setup" }],
    ["network_policy_rollback", 60 * 24 * 5, "demo-user-admin", "ok", { source_revision: 13 }],
    ["network_person_create", 60 * 24 * 21, "demo-user-admin", "ok", { display_name: "Jo" }],
    ["network_device_create", 60 * 24 * 22, "demo-user-admin", "ok", { label: "Kitchen tablet" }],
    ["network_grant_create", 60 * 24 * 25, "demo-user-admin", "ok", { grant_name: "network_enroll" }],
  ];
  const audit: NetworkAuditRow[] = [
    [
      "network_gateway_desired_policy_set",
      45,
      { gateway_id: GATEWAY, revision: 15 },
    ],
    ["network_policy_publish", 45, { revision: 15 }],
    [
      "network_gateway_credential_rotate",
      60 * 24 * 12,
      { gateway_id: GATEWAY, rotated_from: "cred-demo-0" },
    ],
    [
      "network_gateway_credential_issue",
      60 * 24 * 12 + 1,
      { gateway_id: GATEWAY, commands: ["heartbeat", "read_policy"] },
    ],
    ["network_policy_publish", 60 * 24 * 3, { revision: 14 }],
    ["network_gateway_create", 60 * 24 * 20, { kind: "dns" }],
  ].map(([action, minutes, detail], i) => ({
    id: 100 - i,
    ts: ago(minutes as number),
    household_id: HOUSEHOLD,
    actor: "demo-user-admin",
    client_ip: "192.168.1.20",
    action: action as string,
    status: "ok",
    detail: detail as Record<string, unknown>,
  }));
  extraAudit.forEach(([action, minutes, actor, status, detail], i) =>
    audit.push({
      id: 90 - i,
      ts: ago(minutes),
      household_id: HOUSEHOLD,
      actor,
      client_ip: "192.168.1.20",
      action,
      status,
      detail,
    }),
  );
  const minute = (row: NetworkAuditRow) => Math.floor(Date.parse(row.ts) / 60_000);
  audit.sort((x, y) => minute(y) - minute(x) || y.id - x.id);

  const now = () => new Date().toISOString();
  const text = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";

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
        is_default_profile: false,
        note: text(b.note) || null,
        created_at: now(),
      });
      return { id: created };
    },
    networkPersonUpdate: async (_household, personId, body) => {
      const b = asRecord(body);
      const person = persons.find((p) => p.id === personId);
      if (person) {
        if (typeof b.display_name === "string")
          person.display_name = b.display_name.trim();
        if ("note" in b) person.note = text(b.note) || null;
        if (typeof b.is_default_profile === "boolean") {
          if (b.is_default_profile) for (const p of persons) p.is_default_profile = false;
          person.is_default_profile = b.is_default_profile;
        }
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
        household_id: HOUSEHOLD,
        label: text(b.label),
        shared: b.shared === true,
        device_type: (text(b.device_type) ||
          "unknown") as NetworkDevice["device_type"],
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
        active: true,
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
        if (typeof b.role === "string")
          assignment.role = b.role as NetworkAssignment["role"];
        if (typeof b.active === "boolean") assignment.active = b.active;
        // Omitted keeps; explicit null (or empty) clears.
        if ("agent_id" in b) assignment.agent_id = text(b.agent_id) || null;
        if ("note" in b) assignment.note = text(b.note) || null;
        assignment.updated_at = now();
      }
      return { ok: true };
    },

    networkConnections: async () => ({ connections }),
    networkConnectionCreate: async () => ({ id: id("con") }),
    networkConnectionUpdate: async (_household, connectionId, body) => {
      const b = asRecord(body);
      const c = connections.find((x) => x.id === connectionId);
      if (c) {
        // Omitted = keep; explicit null = clear; a value = set.
        if ("assignment_id" in b) c.assignment_id = text(b.assignment_id) || null;
        if ("enrolled_agent_id" in b) c.enrolled_agent_id = text(b.enrolled_agent_id) || null;
        if (typeof b.status === "string") c.status = b.status as NetworkConnection["status"];
        if ("observed_at" in b) c.observed_at = text(b.observed_at) || null;
        if ("last_seen_at" in b) c.last_seen_at = text(b.last_seen_at) || null;
        if ("revoked_at" in b) c.revoked_at = text(b.revoked_at) || null;
        if ("note" in b) c.note = text(b.note) || null;
        c.updated_at = now();
      }
      return { ok: true };
    },

    networkAgentEnrollments: async () => ({ enrollments }),
    networkAgentEnroll: async () => ({ ok: true }),

    networkGrants: async () => ({ grants }),
    networkGrantCreate: async (_household, body) => {
      const b = asRecord(body);
      const user = text(b.user_id);
      const grant = text(b.grant) as NetworkGrantName;
      if (grants.some((g) => g.user_id === user && g.grant_name === grant))
        return { ok: true, created: false };
      grants.push({ household_id: HOUSEHOLD, user_id: user, grant_name: grant, granted_at: now() });
      return { ok: true, created: true };
    },
    networkGrantDelete: async (_household, userId, grant) => {
      if (
        grant === "network_admin" &&
        grants.filter((g) => g.grant_name === "network_admin").length <= 1
      )
        throw new ApiError("The last network administrator cannot be removed.", 409);
      const index = grants.findIndex((g) => g.user_id === userId && g.grant_name === grant);
      if (index >= 0) grants.splice(index, 1);
      return { ok: true };
    },

    networkBindings: async () => ({ bindings }),
    networkBindingCreate: async (_household, body) => {
      const b = asRecord(body);
      if (bindings.some((x) => x.active && x.person_id === text(b.person_id)))
        throw new ApiError("That person is already mapped to a dashboard user.", 409);
      const created = id("bnd");
      bindings.push({
        id: created,
        dashboard_user: text(b.user_id),
        person_id: text(b.person_id),
        generation: 1,
        active: true,
        created_at: now(),
        revoked_at: null,
        dashboard_username: "admin",
        dashboard_display_name: "Demo Admin",
        person_display_name:
          persons.find((p) => p.id === text(b.person_id))?.display_name ?? "",
      });
      return { ok: true, binding_id: created };
    },
    networkBindingDelete: async (_household, bindingId) => {
      const binding = bindings.find((x) => x.id === bindingId);
      if (binding && binding.active) {
        binding.active = false;
        binding.revoked_at = now();
        binding.generation += 1;
        for (const a of deviceAuths) if (a.binding_id === bindingId) a.status = "revoked";
        if (binding.dashboard_user === DEMO_USER) {
          ownDevices.length = 0;
          endSessionsOf();
        }
      }
      return { ok: true };
    },
    networkDeviceAuthorizations: async (_household, bindingId, params) => {
      const rows = deviceAuths.filter((a) => a.binding_id === bindingId);
      const p = asRecord(params);
      const limit = typeof p.limit === "number" ? p.limit : rows.length;
      const offset = typeof p.offset === "number" ? p.offset : 0;
      const slice = rows.slice(offset, offset + limit);
      return {
        enrollments: slice,
        limit,
        offset,
        returned: slice.length,
        truncated: slice.length === limit,
      };
    },
    networkDeviceAuthorize: async (_household, bindingId, body) => {
      const deviceId = text(asRecord(body).device_id);
      if (deviceAuths.some((a) => a.binding_id === bindingId && a.device_id === deviceId && a.status === "enrolled"))
        throw new ApiError("That device is already authorized for this person.", 409);
      const created = id("enr");
      deviceAuths.push({
        id: created,
        binding_id: bindingId,
        device_id: deviceId,
        generation: 1,
        status: "enrolled",
        authorized_by: DEMO_USER,
        created_at: now(),
      });
      const binding = bindings.find((x) => x.id === bindingId);
      const device = devices.find((d) => d.id === deviceId);
      if (binding?.dashboard_user === DEMO_USER && device && !ownDevices.some((d) => d.id === deviceId))
        ownDevices.push({
          id: device.id,
          label: device.label,
          device_type: device.device_type,
          shared: device.shared,
          enrollment_id: created,
          enrollment_status: "enrolled",
        });
      return { ok: true, enrollment_id: created };
    },

    networkOwnDevices: async () => {
      requireBinding();
      return { devices: ownDevices };
    },
    networkOwnDeviceRegister: async (_household, body) => {
      requireBinding();
      const b = asRecord(body);
      const created = id("dev-own");
      ownDevices.push({
        id: created,
        label: text(b.label),
        device_type: text(b.device_type) || "other",
        shared: b.shared === true,
        enrollment_id: id("enr"),
        enrollment_status: "enrolled",
      });
      return { ok: true, device_id: created, status: "enrolled", network_coverage: "unverified" };
    },
    networkOwnDeviceEnd: async (_household, deviceId) => {
      requireBinding();
      const index = ownDevices.findIndex((d) => d.id === deviceId);
      if (index >= 0) ownDevices.splice(index, 1);
      endSessionsOf(deviceId);
      return { ok: true };
    },
    networkOwnGrants: async () => {
      requireBinding();
      return { grants: ownGrants };
    },
    networkSetupGrantIssue: async (_household, body) => {
      requireBinding();
      const b = body;
      if (!ownDevices.some((d) => d.id === b.device_id))
        throw new ApiError("That device is not enrolled to you.", 404);
      const grantId = id("grt");
      const secret = randomSecret();
      const expires = new Date(Date.now() + b.expires_in_secs * 1000).toISOString();
      grantSecrets.set(grantId, secret);
      ownGrants.unshift({
        id: grantId,
        device_id: b.device_id,
        purpose: b.purpose,
        expires_at: expires,
        consumed_at: null,
        revoked_at: null,
        created_at: now(),
      });
      return {
        grant_id: grantId,
        secret,
        household_id: HOUSEHOLD,
        device_id: b.device_id,
        purpose: b.purpose,
        expires_at: expires,
        status: "issued",
        setup: "pending_setup",
        network_coverage: "unverified",
        note: "Scoped receipt only. No proxy credential, client trust material or DNS person identity is delivered by this endpoint.",
      };
    },
    networkSetupGrantConsume: async (_household, body) => {
      requireBinding();
      const grant = ownGrants.find((g) => g.id === body.grant_id);
      if (
        !grant ||
        grantSecrets.get(body.grant_id) !== body.secret.trim() ||
        grant.device_id !== body.device_id ||
        grant.purpose !== body.purpose ||
        grant.consumed_at ||
        grant.revoked_at ||
        new Date(grant.expires_at).getTime() < Date.now()
      )
        throw new ApiError("Setup grant is invalid, expired or already used.", 403);
      grant.consumed_at = now();
      grantSecrets.delete(grant.id);
      endSessionsOf(body.device_id);
      const verified = now();
      const expires = new Date(Date.now() + 8 * 3600_000).toISOString();
      const sessionId = id("ses");
      ownSessions.unshift({
        id: sessionId,
        device_id: body.device_id,
        purpose: body.purpose as NetworkSetupPurpose,
        verification_method: "oidc_session",
        verified_at: verified,
        expires_at: expires,
        ended_at: null,
        person_display_name: activeBinding()?.person_display_name ?? "Jo",
      });
      return {
        session_id: sessionId,
        household_id: HOUSEHOLD,
        device_id: body.device_id,
        purpose: body.purpose,
        verification_method: "oidc_session",
        verified_at: verified,
        expires_at: expires,
        status: "verified_session",
        network_coverage: "unverified_runtime_identity",
        note: "OIDC/session evidence only. This does not establish that DNS or proxy traffic is routed, inspected or protected for a person on a shared device.",
      };
    },
    networkOwnSessions: async () => {
      requireBinding();
      return { sessions: ownSessions };
    },
    networkOwnSessionsEndAll: async () => {
      requireBinding();
      const r = endSessionsOf();
      return {
        ok: true,
        ended: r.ended,
        grants_revoked: r.grants,
        scope: "this household and binding only; dashboard session unaffected",
      };
    },
    networkOwnSessionEnd: async (_household, sessionId) => {
      requireBinding();
      const session = ownSessions.find((x) => x.id === sessionId);
      if (session && !session.ended_at) session.ended_at = now();
      return { ok: true, grants_revoked: 0, scope: "this device and binding only" };
    },

    networkAudit: async (_household, params): Promise<NetworkAuditResponse> => {
      const f = asRecord(params);
      const str = (v: unknown) => (typeof v === "string" && v ? v : null);
      const time = (v: unknown, name: string) => {
        const raw = str(v);
        if (raw == null) return null;
        const t = Date.parse(raw);
        if (Number.isNaN(t)) throw new ApiError(`${name} must be an RFC3339 timestamp`, 400);
        return t;
      };
      const from = time(f.from, "from");
      const to = time(f.to, "to");
      if (from != null && to != null && from > to)
        throw new ApiError("from must not be after to", 400);
      const limit = typeof f.limit === "number" ? f.limit : 50;
      const offset = typeof f.offset === "number" ? f.offset : 0;
      if (limit < 1 || limit > 1000) throw new ApiError("limit must be between 1 and 1000", 400);
      if (offset < 0 || offset > 100_000)
        throw new ApiError("offset must be between 0 and 100000", 400);
      const action = str(f.action);
      const actor = str(f.actor);
      const matching = audit.filter((row) => {
        const t = Date.parse(row.ts);
        return (
          (action == null || row.action === action) &&
          (actor == null || row.actor === actor) &&
          (from == null || t >= from) &&
          (to == null || t <= to)
        );
      });
      const rows = matching.slice(offset, offset + limit);
      const next = offset + rows.length;
      const hasMore = next < matching.length;
      return {
        rows,
        total: matching.length,
        has_more: hasMore,
        next_offset: hasMore ? next : null,
        pagination_limited: false,
      };
    },
    networkEnrollmentContexts: async (): Promise<NetworkEnrollmentContextPage> => {
      const binding = activeBinding();
      const contexts = binding
        ? [
            {
              household_id: HOUSEHOLD,
              household_name: households[0]?.name ?? "Home",
              person_id: binding.person_id,
              person_display_name: binding.person_display_name,
              binding_id: binding.id,
              generation: binding.generation,
            },
          ]
        : [];
      return {
        contexts,
        count: contexts.length,
        total: contexts.length,
        has_more: false,
        next_offset: null,
        pagination_limited: false,
      };
    },
    networkPolicyCurrent: async (): Promise<NetworkPolicyViewResponse> => ({
      policy: policyView(Math.max(...policies.map((p) => p.revision))),
    }),
    networkPolicyRevision: async (_household, revision): Promise<NetworkPolicyViewResponse> => ({
      policy: policyView(checkRevision(revision)),
    }),
    networkPolicyDiff: async (_household, fromRevision, toRevision): Promise<NetworkPolicyDiffResponse> => ({
      diff: buildDiff(policyView(checkRevision(fromRevision)), policyView(checkRevision(toRevision))),
    }),

    networkGateways: async (_household, params) => ({
      gateways: gateways.filter((g) => !params?.kind || g.kind === params.kind),
    }),
    networkGatewayCreate: async (_household, body) => {
      const b = asRecord(body);
      const created = id("gw");
      gateways.push({
        id: created,
        household_id: HOUSEHOLD,
        kind: b.kind === "proxy" ? "proxy" : "dns",
        label: text(b.label),
        enabled: true,
        capabilities: [],
        last_seen_at: null,
        revoked_at: null,
        created_at: now(),
        updated_at: now(),
      });
      return { id: created };
    },
    networkGatewayRevoke: async (_household, gatewayId) => {
      const gateway = gateways.find((g) => g.id === gatewayId);
      if (gateway) {
        gateway.revoked_at = now();
        gateway.enabled = false;
      }
      return { ok: true };
    },
    networkGatewayCredentials: async (_household, gatewayId) => ({
      credentials: credentials.filter((c) => c.gateway_id === gatewayId),
    }),
    networkGatewayCredentialIssue: async (_household, gatewayId, body) =>
      issueCredential(gatewayId, body, null),
    networkGatewayCredentialRotate: async (
      _household,
      gatewayId,
      credentialId,
      body,
    ) => {
      const old = credentials.find((c) => c.id === credentialId);
      if (old) old.revoked_at = now();
      return issueCredential(gatewayId, body, credentialId);
    },
    networkGatewayCredentialRevoke: async (
      _household,
      _gatewayId,
      credentialId,
    ) => {
      const credential = credentials.find((c) => c.id === credentialId);
      if (credential) credential.revoked_at = now();
      return { ok: true };
    },
    networkGatewayReports: async (_household, gatewayId, params) => ({
      reports: page(
        reports.filter((r) => r.gateway_id === gatewayId),
        params,
      ),
    }),

    networkPolicies: async (_household, params) => {
      const rows = page(policies, params);
      return { policies: rows, count: rows.length };
    },
    networkPolicyPublish: async (_household, body) => savePolicy(null, body),
    networkPolicyRollback: async (_household, body) =>
      savePolicy(asRecord(body).source_revision),
    networkGatewayDesiredPolicy: async (_household, gatewayId) => ({
      desired: desired?.gateway_id === gatewayId ? desired : null,
    }),
    networkGatewayDesiredPolicySet: async (_household, gatewayId, body) => {
      desired = {
        household_id: HOUSEHOLD,
        gateway_id: gatewayId,
        kind: gateways.find((g) => g.id === gatewayId)?.kind ?? "dns",
        revision: Number(asRecord(body).revision) || 15,
        assigned_by: "demo-user-admin",
        assigned_at: now(),
      };
      return { desired };
    },
  };

  function issueCredential(
    gatewayId: string,
    body: unknown,
    rotatedFrom: string | null,
  ): { credential_id: string; token: string; expires_at: string } {
    const b = asRecord(body);
    const hours =
      typeof b.expires_in_hours === "number" ? b.expires_in_hours : 24;
    const commands =
      Array.isArray(b.commands) && b.commands.length > 0
        ? b.commands
        : ["heartbeat"];
    const credentialId = id("cred");
    const expires = new Date(Date.now() + hours * 3_600_000).toISOString();
    credentials.unshift({
      id: credentialId,
      household_id: HOUSEHOLD,
      gateway_id: gatewayId,
      kind: gateways.find((g) => g.id === gatewayId)?.kind ?? "dns",
      audience: "vantyr-gateway-worker",
      allowed_commands:
        commands as NetworkGatewayCredential["allowed_commands"],
      expires_at: expires,
      revoked_at: null,
      last_used_at: null,
      issued_at: now(),
      rotated_from: rotatedFrom,
    });
    return {
      credential_id: credentialId,
      token: `${credentialId}.demo-secret-shown-once`,
      expires_at: expires,
    };
  }

  function savePolicy(
    rolledBackFrom: unknown,
    draft?: NetworkPolicyDraft,
  ): {
    revision: number;
    body_sha256: string;
    status: "saved";
  } {
    const revision = Math.max(...policies.map((p) => p.revision)) + 1;
    const meta = policyMeta(
      revision,
      0,
      typeof rolledBackFrom === "number" ? rolledBackFrom : null,
    );
    policies.unshift(meta);
    const source =
      typeof rolledBackFrom === "number" ? policyBodies.get(rolledBackFrom) : undefined;
    policyBodies.set(revision, {
      household_id: HOUSEHOLD,
      person_rules: {},
      exceptions: [],
      default_effect: "deny",
      baseline: [],
      device_profiles: {},
      timezone: "UTC",
      stale_after_secs: 3600,
      event_retention_secs: 14 * 86400,
      ...(source ?? {}),
      ...(draft
        ? {
            baseline: draft.baseline,
            device_profiles: draft.device_profiles,
            timezone: draft.timezone,
            stale_after_secs: draft.stale_after_secs,
            event_retention_secs: draft.event_retention_secs,
          }
        : {}),
      revision,
      published_at: meta.published_at,
    });
    return { revision, body_sha256: meta.body_sha256, status: "saved" };
  }
}
