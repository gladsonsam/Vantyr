import type {
  NetworkPolicyDraft,
  NetworkPolicyRule,
  NetworkPolicyView,
} from "@/api/types";

/** Stored content the composer cannot carry into a new draft (the server refuses it for now). */
export type DroppedPolicyContent =
  | { kind: "person_rules"; count: number }
  | { kind: "exceptions"; count: number }
  | { kind: "category_matchers"; count: number }
  | { kind: "any_matchers"; count: number }
  | { kind: "baseline_allow"; count: number };

const supported = (rule: NetworkPolicyRule) =>
  typeof rule.matcher === "object" &&
  ("domain_suffix" in rule.matcher || "host_exact" in rule.matcher);

/**
 * Builds an editable draft from the CONTENT of a stored revision only. Household, revision,
 * publish time, digest and provenance are never copied; the caller supplies `expected_revision`
 * when publishing. Anything the composer cannot represent is dropped and reported in `dropped`
 * (empty when nothing was lost).
 */
export function policyToDraft(view: NetworkPolicyView): {
  draft: NetworkPolicyDraft;
  dropped: DroppedPolicyContent[];
} {
  const body = view.policy;
  let category = 0;
  let any = 0;
  let baselineAllow = 0;
  const keep = (rule: NetworkPolicyRule): boolean => {
    if (supported(rule)) return true;
    if (rule.matcher === "any") any += 1;
    else category += 1;
    return false;
  };

  const baseline = body.baseline.filter((rule) => {
    if (!keep(rule)) return false;
    if (rule.effect === "allow") {
      baselineAllow += 1;
      return false;
    }
    return true;
  });
  const device_profiles = Object.fromEntries(
    Object.entries(body.device_profiles).map(([name, rules]) => [
      name,
      rules.filter(keep),
    ]),
  );

  const personRules = Object.values(body.person_rules).reduce(
    (n, rules) => n + rules.length,
    0,
  );
  const dropped: DroppedPolicyContent[] = [];
  if (personRules > 0) dropped.push({ kind: "person_rules", count: personRules });
  if (body.exceptions.length > 0)
    dropped.push({ kind: "exceptions", count: body.exceptions.length });
  if (category > 0) dropped.push({ kind: "category_matchers", count: category });
  if (any > 0) dropped.push({ kind: "any_matchers", count: any });
  if (baselineAllow > 0) dropped.push({ kind: "baseline_allow", count: baselineAllow });

  return {
    draft: {
      baseline,
      device_profiles,
      default_effect: "deny",
      timezone: body.timezone,
      stale_after_secs: body.stale_after_secs,
      event_retention_secs: body.event_retention_secs,
    },
    dropped,
  };
}
