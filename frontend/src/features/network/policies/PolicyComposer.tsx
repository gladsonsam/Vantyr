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
import { policyToDraft, usePolicyCurrent, usePolicyMutations } from "@/api/queries/network";
import SlideCommit from "@/components/react-bits/SlideCommit";
import { HelpTip } from "@/components/common/HelpTip";
import { SettingsCardBody, SettingsSection } from "@/features/network/components/SettingsSection";
import {
  CONFLICT_MESSAGE,
  LIMITS,
  MATCHER_LABEL,
  countRules,
  draftSizeBytes,
  editorFromDraft,
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
import { droppedText, readError } from "./policyViewLib";

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
          Keeps the schedule it had in the revision you started from. Editing schedules is not
          supported here yet.
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
 * Compose a NEW revision, empty or from the current (highest saved) one. Publishing creates a new
 * immutable revision from exactly this content and leaves earlier revisions in history; content
 * the composer cannot carry over is listed before you publish, and saving assigns it to no gateway.
 */
export function PolicyComposer({
  household,
  timezone,
  latest,
}: {
  household: string;
  timezone: string;
  latest: NetworkPolicyVersion | undefined;
}) {
  const { publish } = usePolicyMutations(household);
  const [state, setState] = useState<EditorState>(() => emptyEditor(timezone));
  const [commitKey, setCommitKey] = useState(0);
  const [base, setBase] = useState<{ revision: number; dropped: string[] } | null>(null);
  const current = usePolicyCurrent(household);
  const [saved, setSaved] = useState<string | null>(null);

  const issues = useMemo(() => validateEditor(state), [state]);
  const problems = issueList(issues);
  const total = countRules(state);

  const startFromCurrent = () => {
    if (!current.data) return;
    const view = current.data.policy;
    const { draft, dropped } = policyToDraft(view);
    setState(editorFromDraft(draft));
    setSaved(null);
    setBase({
      revision: view.revision,
      dropped: [
        ...dropped.map(droppedText),
        ...(view.policy.default_effect !== "deny"
          ? ["the household default (it becomes block)"]
          : []),
      ],
    });
  };
  const startEmpty = () => {
    setState(emptyEditor(timezone));
    setBase(null);
    setSaved(null);
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
          ? `Start from the current revision (r${latest.revision}) or from scratch. Publishing creates a new revision from exactly the content you compose; earlier revisions stay in history.`
          : "Compose the first revision."
      }
      icon={<FilePlus2 />}
      action={
        <>
          {latest ? (
            <Button variant="outline" size="sm" disabled={!current.data} onClick={startFromCurrent}>
              {current.isPending
                ? "Loading current…"
                : `Start from current (r${current.data?.policy.revision ?? latest.revision})`}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={startEmpty}>
            Start empty
          </Button>
          <HelpTip label="About composing a revision">
            “Current” is the highest saved revision, not necessarily the one a gateway is using.
            Publishing saves a new revision with exactly the rules listed here; it does not merge
            with the latest one. Saving applies nothing: assign the revision to a gateway from
            History afterwards.
          </HelpTip>
        </>
      }
    >
      <SettingsCardBody className="space-y-8">
        {current.isError && latest ? (
          <p role="alert" className="text-[0.8125rem] font-medium text-destructive">
            Couldn’t load the current revision: {readError(current.error, "current revision")}
          </p>
        ) : null}
        {base ? (
          <div
            role="status"
            className="space-y-1 rounded-xl border border-border/70 px-4 py-3 text-[0.8125rem]"
          >
            <div>Started from r{base.revision}.</div>
            <div
              className={
                base.dropped.length > 0 ? "font-medium text-warning" : "text-muted-foreground"
              }
            >
              {base.dropped.length > 0
                ? `Publishing creates a new revision using exactly the content below; r${base.revision} remains in history. The new revision will omit: ${base.dropped.join(", ")}.`
                : `Nothing was left out. Publishing creates a new revision using exactly the content below; r${base.revision} remains in history.`}
            </div>
          </div>
        ) : null}

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
              {state.profiles.length === 1 ? "" : "s"}) · about {formatBytes(draftSizeBytes(state))}
            </div>
            <div className="text-muted-foreground">
              {latest
                ? `Latest saved is r${latest.revision} (${formatBytes(latest.body_bytes)}). This saves a new revision with exactly the content above; ${base ? `r${base.revision}` : "earlier revisions"} remain in history and no gateway is assigned automatically. If someone publishes first, it is refused.`
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
              const result = await publish.mutateAsync(
                toDraft(state, base?.revision ?? latest?.revision),
              );
              setSaved(
                `Saved as revision ${result.revision}. It is not assigned to any gateway yet; assign it from History.`,
              );
              return result;
            }}
            onDone={() => {
              setState(emptyEditor(timezone));
              setBase(null);
              setCommitKey((k) => k + 1);
            }}
          />
        </div>
      </SettingsCardBody>
    </SettingsSection>
  );
}
