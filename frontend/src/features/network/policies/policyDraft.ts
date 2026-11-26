import type {
  NetworkPolicyDraft,
  NetworkPolicyEffect,
  NetworkPolicyRule,
} from "@/api/types/network";
import type { PolicyRule, PolicySnapshot, Weekday } from "@/features/network/runtime/types";

/**
 * Editor model for composing a new policy revision. It mirrors the server's schema checks
 * (server/src/network/policy_dto.rs) so mistakes show up inline before publishing. The server is the
 * authority and re-validates everything.
 */

export const LIMITS = {
  maxRules: 256,
  maxRulesPerProfile: 128,
  maxProfiles: 32,
  maxIdLen: 64,
  maxReasonLen: 200,
  maxDomainLen: 253,
  maxPolicyBytes: 64 * 1024,
  maxStaleSecs: 30 * 24 * 60 * 60,
  maxEventRetentionSecs: 30 * 24 * 60 * 60,
} as const;

export type SupportedMatcherKind = "domain_suffix" | "host_exact";

export const MATCHER_LABEL: Record<SupportedMatcherKind, string> = {
  domain_suffix: "Domain and subdomains",
  host_exact: "Exact host",
};

export interface EditorRule {
  /** Stable key and the rule id sent to the server (unique within the policy). */
  id: string;
  kind: SupportedMatcherKind;
  value: string;
  effect: NetworkPolicyEffect;
  reason: string;
  /** Kept as-is when started from the runtime view; the editor cannot change it yet. */
  schedule: NetworkPolicyRule["schedule"];
}

export interface EditorProfile {
  key: string;
  /** Device profile id: ASCII letters, digits, `-`, `_`, `.` only. */
  profileId: string;
  rules: EditorRule[];
}

export interface EditorState {
  baseline: EditorRule[];
  profiles: EditorProfile[];
  timezone: string;
  staleAfterMinutes: number;
  eventRetentionDays: number;
}

export function emptyEditor(timezone: string): EditorState {
  return {
    baseline: [],
    profiles: [],
    timezone,
    staleAfterMinutes: 60,
    eventRetentionDays: 14,
  };
}

let counter = 0;
export function newRuleId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}`;
}

export function newRule(prefix: string, effect: NetworkPolicyEffect): EditorRule {
  return { id: newRuleId(prefix), kind: "domain_suffix", value: "", effect, reason: "", schedule: null };
}

// ── Validation ──────────────────────────────────────────────────────────────

const hasControl = (s: string) =>
  [...s].some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
const hasSpace = (s: string) => /\s/.test(s);
const utf8Len = (s: string) => new TextEncoder().encode(s).length;

export function domainError(raw: string): string | null {
  const v = raw;
  if (v.length === 0) return "Enter a domain.";
  if (v.length > LIMITS.maxDomainLen) return `At most ${LIMITS.maxDomainLen} characters.`;
  if (hasSpace(v) || hasControl(v)) return "No spaces or control characters.";
  if (v.startsWith(".") || v.endsWith(".")) return "No leading or trailing dot.";
  for (const label of v.split(".")) {
    if (label.length === 0) return "Empty label (two dots in a row).";
    if (label.length > 63) return "Each label is at most 63 characters.";
    if (!/^[A-Za-z0-9-]+$/.test(label)) return "Letters, digits and hyphens only (no wildcards or ports).";
    if (label.startsWith("-") || label.endsWith("-")) return "A label cannot start or end with a hyphen.";
  }
  return null;
}

export function reasonError(reason: string): string | null {
  if (utf8Len(reason) > LIMITS.maxReasonLen) return `Reason is at most ${LIMITS.maxReasonLen} bytes.`;
  if (hasControl(reason)) return "Reason cannot contain control characters.";
  return null;
}

export function profileIdError(id: string): string | null {
  if (id.length === 0) return "Enter a profile id.";
  if (id.length > LIMITS.maxIdLen) return `At most ${LIMITS.maxIdLen} characters.`;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return "Letters, digits, '-', '_' and '.' only.";
  return null;
}

export function timezoneError(tz: string): string | null {
  if (tz.length === 0) return "Enter an IANA timezone.";
  if (tz.length > 64) return "At most 64 characters.";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return null;
  } catch {
    return "Not a known IANA timezone (for example Europe/London).";
  }
}

export interface EditorIssues {
  /** Per rule id. */
  rules: Record<string, string>;
  /** Per profile key. */
  profiles: Record<string, string>;
  settings: { timezone?: string; stale?: string; retention?: string };
  /** Whole-policy problems. */
  policy: string[];
}

export function validateEditor(state: EditorState): EditorIssues {
  const issues: EditorIssues = { rules: {}, profiles: {}, settings: {}, policy: [] };
  const seen = new Set<string>();
  const checkRule = (rule: EditorRule, denyOnly: boolean) => {
    const message =
      (seen.has(rule.id) ? "Duplicate rule id." : null) ??
      (rule.id.length > LIMITS.maxIdLen || hasSpace(rule.id) ? "Invalid rule id." : null) ??
      (denyOnly && rule.effect === "allow" ? "The baseline may only contain deny rules." : null) ??
      domainError(rule.value) ??
      reasonError(rule.reason);
    seen.add(rule.id);
    if (message) issues.rules[rule.id] = message;
  };
  state.baseline.forEach((r) => checkRule(r, true));
  const profileIds = new Set<string>();
  for (const profile of state.profiles) {
    const message =
      profileIdError(profile.profileId) ??
      (profileIds.has(profile.profileId) ? "Profile ids must be unique." : null) ??
      (profile.rules.length > LIMITS.maxRulesPerProfile
        ? `At most ${LIMITS.maxRulesPerProfile} rules per profile.`
        : null);
    profileIds.add(profile.profileId);
    if (message) issues.profiles[profile.key] = message;
    profile.rules.forEach((r) => checkRule(r, false));
  }
  const total = countRules(state);
  if (total === 0) issues.policy.push("Add at least one rule.");
  if (total > LIMITS.maxRules) issues.policy.push(`At most ${LIMITS.maxRules} rules in total.`);
  if (state.profiles.length > LIMITS.maxProfiles) {
    issues.policy.push(`At most ${LIMITS.maxProfiles} device profiles.`);
  }
  const tz = timezoneError(state.timezone);
  if (tz) issues.settings.timezone = tz;
  const staleSecs = state.staleAfterMinutes * 60;
  if (!Number.isInteger(state.staleAfterMinutes) || staleSecs < 60 || staleSecs > LIMITS.maxStaleSecs) {
    issues.settings.stale = "Whole minutes, between 1 and 43200 (30 days).";
  }
  if (
    !Number.isInteger(state.eventRetentionDays) ||
    state.eventRetentionDays < 1 ||
    state.eventRetentionDays * 86400 > LIMITS.maxEventRetentionSecs
  ) {
    issues.settings.retention = "Whole days, between 1 and 30.";
  }
  if (
    Object.keys(issues.rules).length === 0 &&
    Object.keys(issues.profiles).length === 0 &&
    issues.policy.length === 0
  ) {
    const size = utf8Len(JSON.stringify(toDraft(state)));
    if (size > LIMITS.maxPolicyBytes) issues.policy.push("The policy would exceed 64 KiB.");
  }
  return issues;
}

/** A flat, ordered list of problems for the summary under the form. */
export function issueList(issues: EditorIssues): string[] {
  return [
    ...issues.policy,
    ...Object.values(issues.profiles),
    ...Object.values(issues.rules),
    ...Object.values(issues.settings).filter((m): m is string => Boolean(m)),
  ];
}

export function countRules(state: EditorState): number {
  return state.baseline.length + state.profiles.reduce((n, p) => n + p.rules.length, 0);
}

// ── Payload ─────────────────────────────────────────────────────────────────

function toApiRule(rule: EditorRule): NetworkPolicyRule {
  return {
    id: rule.id,
    effect: rule.effect,
    matcher: rule.kind === "host_exact" ? { host_exact: rule.value } : { domain_suffix: rule.value },
    schedule: rule.schedule,
    reason: rule.reason,
  };
}

export function toDraft(state: EditorState, expectedRevision?: number): NetworkPolicyDraft {
  return {
    baseline: state.baseline.map(toApiRule),
    device_profiles: Object.fromEntries(
      state.profiles.map((p) => [p.profileId, p.rules.map(toApiRule)]),
    ),
    default_effect: "deny",
    timezone: state.timezone,
    stale_after_secs: Math.round(state.staleAfterMinutes * 60),
    event_retention_secs: Math.round(state.eventRetentionDays * 86400),
    ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}),
  };
}

export function draftSizeBytes(state: EditorState): number {
  return utf8Len(JSON.stringify(toDraft(state)));
}

// ── Starting point from the runtime view ────────────────────────────────────

const DAY: Record<Weekday, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function fromRuntimeRule(rule: PolicyRule, timezone: string): EditorRule {
  return {
    id: rule.id,
    kind: rule.match.kind === "exact" ? "host_exact" : "domain_suffix",
    value: rule.match.value,
    effect: rule.effect,
    reason: rule.reason,
    schedule: rule.schedule
      ? {
          weekdays: rule.schedule.days.map((d) => DAY[d]),
          start_minute: minutes(rule.schedule.from),
          end_minute: minutes(rule.schedule.to),
          timezone,
        }
      : null,
  };
}

export interface SnapshotImport {
  state: EditorState;
  /** What could not come along because the server refuses it for now. */
  skipped: { people: number; exceptions: number; baselineAllow: number };
}

/** Convert the runtime view to an editor start. Unsupported parts are dropped, and counted. */
export function editorFromSnapshot(snapshot: PolicySnapshot): SnapshotImport {
  const baselineAllow = snapshot.baseline.filter((r) => r.effect === "allow").length;
  return {
    state: {
      baseline: snapshot.baseline
        .filter((r) => r.effect === "deny")
        .map((r) => fromRuntimeRule(r, snapshot.timezone)),
      profiles: snapshot.deviceDefaults.map((scope) => ({
        key: `p-${scope.scopeId}`,
        profileId: scope.scopeId,
        rules: scope.rules.map((r) => fromRuntimeRule(r, snapshot.timezone)),
      })),
      timezone: snapshot.timezone,
      staleAfterMinutes: Math.max(1, Math.round(snapshot.staleAfterSeconds / 60)),
      eventRetentionDays: 14,
    },
    skipped: {
      people: snapshot.personRules.reduce((n, s) => n + s.rules.length, 0),
      exceptions: snapshot.exceptions.length,
      baselineAllow,
    },
  };
}

// ── Revision helpers ────────────────────────────────────────────────────────

export const CONFLICT_MESSAGE = "Someone published a newer revision; review it and try again.";

export const shortHash = (sha: string) => sha.slice(0, 8);

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}
