import type {
  NetworkPolicyDiff,
  NetworkPolicyEffect,
  NetworkPolicyRule,
  NetworkPolicyRuleChange,
  NetworkPolicySettingChange,
  NetworkPolicyView,
} from "@/api/types/network";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { shortHash } from "./policyDraft";
import { policyToDraft } from "@/api/queries/network";
import { droppedText, formatSeconds, plural, scopeLabel } from "./policyViewLib";

// ── Wording ─────────────────────────────────────────────────────────────────

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

function matcherText(matcher: NetworkPolicyRule["matcher"]): string {
  if (matcher === "any") return "Everything";
  if ("domain_suffix" in matcher) return `${matcher.domain_suffix} and subdomains`;
  if ("host_exact" in matcher) return `${matcher.host_exact} (exact host)`;
  if ("category" in matcher) return `Category: ${matcher.category}`;
  return "Unknown match";
}

function scheduleText(schedule: NetworkPolicyRule["schedule"]): string | null {
  if (!schedule) return null;
  const days =
    schedule.weekdays.length === 7
      ? "every day"
      : schedule.weekdays.map((d) => DAYS[d] ?? `day ${d}`).join(", ");
  return `${days}, ${hhmm(schedule.start_minute)}–${hhmm(schedule.end_minute)} (${schedule.timezone})`;
}

const effectText = (e: NetworkPolicyEffect) => (e === "allow" ? "Allow" : "Block");
const effectColor = (e: NetworkPolicyEffect) =>
  e === "allow" ? "text-success" : "text-destructive";
const effectDot = (e: NetworkPolicyEffect) => (e === "allow" ? "bg-success" : "bg-destructive");

// ── Shared bits ─────────────────────────────────────────────────────────────

function Dot({ className }: { className: string }) {
  return <span className={`mt-2 size-1.5 shrink-0 rounded-full ${className}`} aria-hidden="true" />;
}

/** One rule: coloured action, what it matches, and any schedule or reason. */
function RuleText({ rule }: { rule: NetworkPolicyRule }) {
  const schedule = scheduleText(rule.schedule);
  return (
    <span className="min-w-0 break-words">
      <span className={`font-medium ${effectColor(rule.effect)}`}>{effectText(rule.effect)}</span>{" "}
      <span className="font-mono text-[0.8125rem]">{matcherText(rule.matcher)}</span>
      {schedule ? <span className="text-muted-foreground"> · {schedule}</span> : null}
      {rule.reason ? <span className="text-muted-foreground"> · {rule.reason}</span> : null}
    </span>
  );
}

function RuleLines({ rules, empty }: { rules: NetworkPolicyRule[]; empty: string }) {
  if (rules.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {rules.map((rule) => (
        <li key={rule.id} className="flex items-start gap-3">
          <Dot className={effectDot(rule.effect)} />
          <RuleText rule={rule} />
        </li>
      ))}
    </ul>
  );
}

// ── A stored revision, read-only ────────────────────────────────────────────

/** Metadata and body of one stored revision. A saved proposal, not evidence of anything applied. */
export function PolicyBodyView({ view }: { view: NetworkPolicyView }) {
  const body = view.policy;
  const { dropped } = policyToDraft(view);
  // Category and match-everything rules are shown below; person rules and exceptions only as counts.
  const present = dropped.filter(
    (d) =>
      d.kind === "person_rules" ||
      d.kind === "exceptions" ||
      d.kind === "category_matchers" ||
      d.kind === "any_matchers",
  );
  const profiles = Object.entries(body.device_profiles).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="space-y-6">
      <div className="space-y-1 text-[0.8125rem] text-muted-foreground">
        <div>
          Saved <TimeAgo iso={view.published_at} /> by {view.published_by ?? "unknown author"}
          {view.rolled_back_from_revision !== null
            ? ` · rolled back from r${view.rolled_back_from_revision}`
            : ""}
        </div>
        <div>
          Content hash{" "}
          <span className="font-mono" title={view.body_sha256}>
            {shortHash(view.body_sha256)}
          </span>{" "}
          (content integrity only; it says nothing about what any gateway applied)
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Household baseline</h4>
        <RuleLines rules={body.baseline} empty="No baseline rules." />
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium">Device profiles</h4>
        {profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No device profiles.</p>
        ) : (
          profiles.map(([name, rules]) => (
            <div key={name} className="space-y-2 rounded-xl border border-border/70 px-4 py-3">
              <div className="text-sm font-medium">{name}</div>
              <RuleLines rules={rules} empty="No rules." />
            </div>
          ))
        )}
      </div>

      <div className="space-y-1.5">
        <h4 className="text-sm font-medium">Settings</h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Household default</dt>
          <dd>{body.default_effect === "allow" ? "Allow" : "Block"}</dd>
          <dt className="text-muted-foreground">Timezone</dt>
          <dd>{body.timezone}</dd>
          <dt className="text-muted-foreground">Keep last policy for</dt>
          <dd>{formatSeconds(body.stale_after_secs)} if the server is unreachable</dd>
          <dt className="text-muted-foreground">Keep events for</dt>
          <dd>{formatSeconds(body.event_retention_secs)}</dd>
        </dl>
      </div>

      {present.length > 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          Also stored in this revision, not editable in the composer yet:{" "}
          {present.map(droppedText).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

// ── A semantic diff ─────────────────────────────────────────────────────────

function Count({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
      <span className="font-medium tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

const asNames = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function plainValue(field: string, v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "number" && (field === "stale_after_secs" || field === "event_retention_secs")) {
    return formatSeconds(v);
  }
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const json = JSON.stringify(v);
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

const SETTING_LABEL: Record<string, string> = {
  default_effect: "Household default",
  timezone: "Timezone",
  stale_after_secs: "Keep last policy for",
  event_retention_secs: "Keep events for",
  device_profile_ids: "Device profiles",
  person_rules: "Person rules",
  exceptions: "Exceptions",
};

function SettingLine({ change }: { change: NetworkPolicySettingChange }) {
  const label = SETTING_LABEL[change.field] ?? change.field;
  if (change.field === "device_profile_ids") {
    const before = asNames(change.before);
    const after = asNames(change.after);
    const added = after.filter((n) => !before.includes(n));
    const removed = before.filter((n) => !after.includes(n));
    return (
      <li className="flex items-start gap-3 text-sm">
        <Dot className="bg-warning" />
        <span>
          <span className="font-medium">{label}</span>
          {added.length > 0 ? (
            <span className="text-success"> · added {added.join(", ")}</span>
          ) : null}
          {removed.length > 0 ? (
            <span className="text-destructive"> · removed {removed.join(", ")}</span>
          ) : null}
          {added.length === 0 && removed.length === 0 ? (
            <span className="text-muted-foreground"> · changed</span>
          ) : null}
        </span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-3 text-sm">
      <Dot className="bg-warning" />
      <span className="min-w-0 break-words">
        <span className="font-medium">{label}</span>{" "}
        <span className="text-muted-foreground">{plainValue(change.field, change.before)}</span>
        {" → "}
        <span>{plainValue(change.field, change.after)}</span>
      </span>
    </li>
  );
}

function RuleChangeLine({ change }: { change: NetworkPolicyRuleChange }) {
  if (change.change === "changed") {
    return (
      <li className="flex items-start gap-3 text-sm">
        <Dot className="bg-warning" />
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium text-warning">Changed</div>
          {change.before ? (
            <div className="text-muted-foreground">
              Before: <RuleText rule={change.before} />
            </div>
          ) : null}
          {change.after ? (
            <div>
              After: <RuleText rule={change.after} />
            </div>
          ) : null}
        </div>
      </li>
    );
  }
  const added = change.change === "added";
  const rule = added ? change.after : change.before;
  return (
    <li className="flex items-start gap-3 text-sm">
      <Dot className={added ? "bg-success" : "bg-destructive"} />
      <div className="min-w-0">
        <span className={`font-medium ${added ? "text-success" : "text-destructive"}`}>
          {added ? "Added" : "Removed"}
        </span>{" "}
        {rule ? <RuleText rule={rule} /> : <span className="font-mono">{change.id}</span>}
      </div>
    </li>
  );
}

/**
 * Semantic change list between two stored revisions. It is a display, not a replayable patch.
 * Provenance (time, digest, rollback) comes from `from`/`to` only.
 */
export function PolicyDiffView({ diff }: { diff: NetworkPolicyDiff }) {
  const { counts } = diff;
  const groups = new Map<string, NetworkPolicyRuleChange[]>();
  for (const change of diff.rules) {
    const list = groups.get(change.scope) ?? [];
    list.push(change);
    groups.set(change.scope, list);
  }
  const shown = diff.rules.length + diff.settings.length;
  const rollbackNote =
    diff.to.rolled_back_from_revision !== null
      ? `r${diff.to.revision} is a rollback copy of r${diff.to.rolled_back_from_revision}.`
      : null;

  return (
    <div className="space-y-5">
      <div className="space-y-1 text-[0.8125rem] text-muted-foreground">
        <div>
          r{diff.from.revision} (<TimeAgo iso={diff.from.published_at} />) → r{diff.to.revision} (
          <TimeAgo iso={diff.to.published_at} />)
        </div>
        {rollbackNote ? <div>{rollbackNote}</div> : null}
        <div>
          Content hashes <span className="font-mono">{shortHash(diff.from.body_sha256)}</span> →{" "}
          <span className="font-mono">{shortHash(diff.to.body_sha256)}</span> (content integrity
          only)
        </div>
      </div>

      {!diff.content_changed ? (
        <p className="rounded-xl border border-border/70 px-4 py-3 text-sm">
          {diff.to.rolled_back_from_revision === diff.from.revision
            ? `Same content as r${diff.from.revision}.`
            : `Same content as r${diff.from.revision}: the rules and settings are identical.`}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Count label="added" value={counts.added_rules} dot="bg-success" />
            <Count label="removed" value={counts.removed_rules} dot="bg-destructive" />
            <Count label="changed" value={counts.changed_rules} dot="bg-warning" />
            <Count
              label="settings changed"
              value={counts.changed_settings}
              dot="bg-muted-foreground"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {plural(counts.total_rules_from, "rule")} in r{diff.from.revision},{" "}
            {plural(counts.total_rules_to, "rule")} in r{diff.to.revision}.
          </p>

          {diff.settings.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Settings</h4>
              <ul className="space-y-1.5">
                {diff.settings.map((change, i) => (
                  <SettingLine key={`${change.field}-${i}`} change={change} />
                ))}
              </ul>
            </div>
          ) : null}

          {[...groups.entries()].map(([scope, changes]) => (
            <div key={scope} className="space-y-2">
              <h4 className="text-sm font-medium">{scopeLabel(scope)}</h4>
              <ul className="space-y-1.5">
                {changes.map((change, i) => (
                  <RuleChangeLine key={`${change.id}-${change.change}-${i}`} change={change} />
                ))}
              </ul>
            </div>
          ))}

          {diff.truncated || diff.omitted_changes > 0 ? (
            <p role="status" className="text-[0.8125rem] text-warning">
              Showing the first {shown} of {shown + diff.omitted_changes} changes;{" "}
              {diff.omitted_changes} more omitted.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
