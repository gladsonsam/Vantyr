import { useMemo, useState } from "react";
import { FilePlus2, Plus, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { errorText, isApiError } from "@/api";
import type { NetworkPolicyEffect, NetworkPolicyVersion } from "@/api/types/network";
import { usePolicyMutations } from "@/api/queries/network";
import SlideCommit from "@/components/react-bits/SlideCommit";
import { HelpTip } from "@/components/common/HelpTip";
import { SettingsCardBody, SettingsSection } from "@/features/network/components/SettingsSection";
import type { PolicySnapshot } from "@/features/network/runtime/types";
import {
  CONFLICT_MESSAGE,
  LIMITS,
  MATCHER_LABEL,
  countRules,
  draftSizeBytes,
  editorFromSnapshot,
  emptyEditor,
  formatBytes,
  issueList,
  newRule,
  newRuleId,
  toDraft,
  validateEditor,
  type EditorProfile,
  type EditorRule,
  type EditorState,
  type SupportedMatcherKind,
} from "./policyDraft";

const KINDS = Object.keys(MATCHER_LABEL) as SupportedMatcherKind[];

function RuleRow({
  rule,
  denyOnly,
  error,
  onChange,
  onRemove,
}: {
  rule: EditorRule;
  denyOnly: boolean;
  error: string | undefined;
  onChange: (next: EditorRule) => void;
  onRemove: () => void;
}) {
  // Show an error once something is typed; an untouched empty row is summarised below instead.
  const shown = error && (rule.value !== "" || rule.reason !== "") ? error : null;
  return (
    <li className="space-y-2 py-3">
      <div className="grid gap-2 md:grid-cols-[11rem_minmax(0,1fr)_6.5rem_auto] md:items-center">
        <Select
          value={rule.kind}
          onValueChange={(v) => v && onChange({ ...rule, kind: v as SupportedMatcherKind })}
        >
          <SelectTrigger aria-label="Match" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {MATCHER_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Domain"
          aria-invalid={shown ? true : undefined}
          placeholder="example.com"
          autoComplete="off"
          spellCheck={false}
          value={rule.value}
          onChange={(e) => onChange({ ...rule, value: e.target.value.trim() })}
        />
        {denyOnly ? (
          <span className="text-sm text-muted-foreground">Block</span>
        ) : (
          <Select
            value={rule.effect}
            onValueChange={(v) => v && onChange({ ...rule, effect: v as NetworkPolicyEffect })}
          >
            <SelectTrigger aria-label="Action" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deny">Block</SelectItem>
              <SelectItem value="allow">Allow</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Remove rule" onClick={onRemove}>
          <X />
        </Button>
      </div>
      <Input
        aria-label="Reason"
        placeholder="Reason (optional)"
        value={rule.reason}
        onChange={(e) => onChange({ ...rule, reason: e.target.value })}
      />
      {rule.schedule ? (
        <p className="text-xs text-muted-foreground">
          Keeps its schedule from the runtime view. Editing schedules is not supported here yet.
        </p>
      ) : null}
      {shown ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {shown}
        </p>
      ) : null}
    </li>
  );
}

function RuleList({
  rules,
  denyOnly,
  errors,
  prefix,
  onChange,
}: {
  rules: EditorRule[];
  denyOnly: boolean;
  errors: Record<string, string>;
  prefix: string;
  onChange: (rules: EditorRule[]) => void;
}) {
  return (
    <div>
      {rules.length > 0 ? (
        <ul className="divide-y divide-border/50">
          {rules.map((rule, i) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              denyOnly={denyOnly}
              error={errors[rule.id]}
              onChange={(next) => onChange(rules.map((r, j) => (j === i ? next : r)))}
              onRemove={() => onChange(rules.filter((_, j) => j !== i))}
            />
          ))}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">No rules.</p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={() => onChange([...rules, newRule(prefix, "deny")])}
      >
        <Plus /> Add rule
      </Button>
    </div>
  );
}

function NumberField({
  label,
  value,
  suffix,
  error,
  onChange,
}: {
  label: string;
  value: number;
  suffix: string;
  error?: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="space-y-1.5 text-sm font-medium">
      {label}
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          className="w-28"
          aria-invalid={error ? true : undefined}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        />
        <span className="text-xs font-normal text-muted-foreground">{suffix}</span>
      </div>
      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </label>
  );
}

/**
 * Compose a NEW revision. The server never sends a policy body to the dashboard, so an existing
 * revision cannot be loaded for editing: what you publish here replaces the content wholesale, as a
 * new revision, and saving it applies it nowhere.
 */
export function PolicyComposer({
  household,
  timezone,
  latest,
  runtimeStart,
}: {
  household: string;
  timezone: string;
  latest: NetworkPolicyVersion | undefined;
  /** The runtime view's snapshot (demo), offered as a starting point when present. */
  runtimeStart: PolicySnapshot | null;
}) {
  const { publish } = usePolicyMutations(household);
  const [state, setState] = useState<EditorState>(() => emptyEditor(timezone));
  const [commitKey, setCommitKey] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const issues = useMemo(() => validateEditor(state), [state]);
  const problems = issueList(issues);
  const total = countRules(state);

  const startFromRuntime = () => {
    if (!runtimeStart) return;
    const { state: next, skipped } = editorFromSnapshot(runtimeStart);
    setState(next);
    setSaved(null);
    const dropped = [
      skipped.people > 0 ? `${skipped.people} person rule${skipped.people === 1 ? "" : "s"}` : null,
      skipped.exceptions > 0
        ? `${skipped.exceptions} exception${skipped.exceptions === 1 ? "" : "s"}`
        : null,
      skipped.baselineAllow > 0
        ? `${skipped.baselineAllow} baseline allow rule${skipped.baselineAllow === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);
    setNote(
      `Started from r${runtimeStart.revision} of the runtime view.` +
        (dropped.length > 0 ? ` Left out, not supported yet: ${dropped.join(", ")}.` : ""),
    );
  };

  const setProfiles = (profiles: EditorProfile[]) => setState((s) => ({ ...s, profiles }));
  const publishError = publish.isError
    ? isApiError(publish.error) && publish.error.status === 409
      ? CONFLICT_MESSAGE
      : errorText(publish.error)
    : null;

  return (
    <SettingsSection
      title="New revision"
      description={
        latest
          ? `Compose a full replacement. The server does not send r${latest.revision}’s rules, so it can’t be edited in place.`
          : "Compose the first revision."
      }
      icon={<FilePlus2 />}
      action={
        <>
          {runtimeStart ? (
            <Button variant="outline" size="sm" onClick={startFromRuntime}>
              Start from r{runtimeStart.revision} (runtime view)
            </Button>
          ) : null}
          <HelpTip label="About composing a revision">
            Publishing saves a new revision with exactly the rules listed here; it does not merge
            with the latest one. Saving applies nothing: assign the revision to a gateway from
            History afterwards.
          </HelpTip>
        </>
      }
    >
      <SettingsCardBody className="space-y-8">
        {note ? <p className="text-[0.8125rem] text-muted-foreground">{note}</p> : null}

        <div className="space-y-2">
          <div>
            <h4 className="text-sm font-medium">Household baseline</h4>
            <p className="text-xs text-muted-foreground">
              Block rules only. Nothing below overrides them.
            </p>
          </div>
          <RuleList
            rules={state.baseline}
            denyOnly
            prefix="base"
            errors={issues.rules}
            onChange={(baseline) => setState((s) => ({ ...s, baseline }))}
          />
        </div>

        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium">Device profiles</h4>
            <p className="text-xs text-muted-foreground">
              Rules for a named group of devices. Anything not matched is blocked by the household
              default.
            </p>
          </div>
          {state.profiles.map((profile, i) => (
            <div
              key={profile.key}
              className="space-y-2 rounded-xl border border-border/70 bg-card/10 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Profile id"
                  placeholder="profile-id"
                  className="max-w-64"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={issues.profiles[profile.key] ? true : undefined}
                  value={profile.profileId}
                  onChange={(e) =>
                    setProfiles(
                      state.profiles.map((p, j) =>
                        j === i ? { ...p, profileId: e.target.value.trim() } : p,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove profile"
                  onClick={() => setProfiles(state.profiles.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              </div>
              {issues.profiles[profile.key] && profile.profileId !== "" ? (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {issues.profiles[profile.key]}
                </p>
              ) : null}
              <RuleList
                rules={profile.rules}
                denyOnly={false}
                prefix="dev"
                errors={issues.rules}
                onChange={(rules) =>
                  setProfiles(state.profiles.map((p, j) => (j === i ? { ...p, rules } : p)))
                }
              />
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setProfiles([
                ...state.profiles,
                { key: newRuleId("profile"), profileId: "", rules: [] },
              ])
            }
          >
            <Plus /> Add device profile
          </Button>
        </div>

        <div className="space-y-1.5">
          <h4 className="text-sm font-medium">Not supported yet</h4>
          <ul className="space-y-1 text-[0.8125rem] text-muted-foreground">
            <li>Person rules: the server refuses them for now.</li>
            <li>Exceptions: the server refuses them for now.</li>
            <li>Category and match-everything rules: the server refuses them for now.</li>
          </ul>
        </div>

        <div className="space-y-3">
          <h4 className="text-sm font-medium">Settings</h4>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <label className="space-y-1.5 text-sm font-medium">
              Timezone
              <Input
                className="w-56"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={issues.settings.timezone ? true : undefined}
                value={state.timezone}
                onChange={(e) => setState((s) => ({ ...s, timezone: e.target.value.trim() }))}
              />
              {issues.settings.timezone ? (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {issues.settings.timezone}
                </p>
              ) : null}
            </label>
            <NumberField
              label="Keep last policy for"
              suffix="minutes if the server is unreachable"
              value={state.staleAfterMinutes}
              error={issues.settings.stale}
              onChange={(n) => setState((s) => ({ ...s, staleAfterMinutes: n }))}
            />
            <NumberField
              label="Keep events for"
              suffix="days"
              value={state.eventRetentionDays}
              error={issues.settings.retention}
              onChange={(n) => setState((s) => ({ ...s, eventRetentionDays: n }))}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            The household default is always block. Limits: {LIMITS.maxRules} rules, 64 KiB.
          </p>
        </div>

        <div className="space-y-3 border-t border-border/50 pt-5">
          <div className="space-y-1 text-[0.8125rem]">
            <div className="font-medium">
              {total} rule{total === 1 ? "" : "s"} ({state.baseline.length} baseline,{" "}
              {total - state.baseline.length} in {state.profiles.length} profile
              {state.profiles.length === 1 ? "" : "s"}) · about{" "}
              {formatBytes(draftSizeBytes(state))}
            </div>
            <div className="text-muted-foreground">
              {latest
                ? `Latest is r${latest.revision} (${formatBytes(latest.body_bytes)}). Only metadata is available, so no rule-level diff. This replaces its content and saves as r${latest.revision + 1}. If someone publishes first, it is refused.`
                : "No revision exists yet, so this becomes the first."}
            </div>
          </div>
          {problems.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-destructive" role="alert">
              {problems.slice(0, 4).map((p, i) => (
                <li key={i}>{p}</li>
              ))}
              {problems.length > 4 ? <li>and {problems.length - 4} more</li> : null}
            </ul>
          ) : null}
          {publishError ? (
            <p role="alert" className="text-[0.8125rem] font-medium text-destructive">
              {publishError}
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="text-[0.8125rem] text-success">
              {saved}
            </p>
          ) : null}
          <SlideCommit
            key={commitKey}
            label="Slide to publish revision"
            doneLabel="Saved"
            errorLabel="Not saved"
            disabled={problems.length > 0 || publish.isPending}
            onConfirm={async () => {
              setSaved(null);
              const result = await publish.mutateAsync(toDraft(state, latest?.revision));
              setSaved(
                `Saved as revision ${result.revision}. It is not assigned to any gateway yet; assign it from History.`,
              );
              return result;
            }}
            onDone={() => {
              setState(emptyEditor(timezone));
              setNote(null);
              setCommitKey((k) => k + 1);
            }}
          />
        </div>
      </SettingsCardBody>
    </SettingsSection>
  );
}
