import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { settingsKeys, settingsQueries } from "@/api/queries/settings";
import type { RetentionPolicy } from "@/api/types";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Field, FieldError, FieldLabel } from "@vantyr/ui/components/field";
import { Input } from "@vantyr/ui/components/input";
import { Spinner } from "@vantyr/ui/components/spinner";
import { useServerDraft } from "@/hooks/useServerDraft";
import { daysToField, fieldToDays, fmtRetentionBrief, parseRetentionField } from "./retentionForm";

function RetentionOverrideField({
  title,
  value,
  onChange,
  globalDays,
  parsed,
  formDisabled,
}: {
  title: string;
  value: string;
  onChange: (v: string) => void;
  globalDays: number | null | undefined;
  parsed: { value: number | null; error: string | null };
  formDisabled: boolean;
}) {
  return (
    <Field>
      <FieldLabel>{title}</FieldLabel>
      <Input
        inputMode="numeric"
        value={value}
        disabled={formDisabled}
        aria-invalid={Boolean(parsed.error)}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Blank = inherit, 0 = unlimited"
        className="h-9"
      />
      {parsed.error ? (
        <FieldError>{parsed.error}</FieldError>
      ) : (
        <p className="text-xs text-muted-foreground">
          Default: {fmtRetentionBrief(globalDays)} · Effective: {fmtRetentionBrief(parsed.value)}
        </p>
      )}
    </Field>
  );
}

function KeyValues({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg bg-muted/50 px-3.5 py-3">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 font-mono text-[13px]">{item.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

const NO_RETENTION_FIELDS = { agKey: "", agWin: "", agUrl: "" };

function toRetentionFields({ override }: { override: RetentionPolicy | null }) {
  const o = override ?? { keylog_days: null, window_days: null, url_days: null };
  return {
    agKey: daysToField(o.keylog_days, "agent"),
    agWin: daysToField(o.window_days, "agent"),
    agUrl: daysToField(o.url_days, "agent"),
  };
}

/** Effective value of one override field: its own parse when set, else the global default. */
function effective(field: string, parsed: { value: number | null; error: string | null }, globalDays: number | null) {
  if (!field.trim()) return fmtRetentionBrief(globalDays);
  return parsed.error ? "Invalid" : fmtRetentionBrief(parsed.value);
}

/** Per-agent retention overrides (blank = inherit the default, 0 = unlimited). Admin only. */
export function AgentRetentionCard({ agentId, isAdmin }: { agentId: string; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const retentionQuery = useQuery(settingsQueries.agentRetention(agentId));

  // Override fields are edited locally; every fresh server copy (load or save) re-seeds them.
  const [fields, setFields] = useServerDraft(
    retentionQuery.data,
    retentionQuery.dataUpdatedAt,
    toRetentionFields,
    NO_RETENTION_FIELDS,
  );
  const { agKey, agWin, agUrl } = fields;
  const agGlobal: RetentionPolicy | null = retentionQuery.data?.global ?? null;
  const [formError, setFormError] = useState<string | null>(null);

  /** `null` clears the overrides. */
  const save = useMutation({
    mutationFn: (body: RetentionPolicy | null) =>
      body ? api.retentionAgentPut(agentId, body) : api.retentionAgentDelete(agentId),
    onSuccess: (res) => queryClient.setQueryData(settingsKeys.agentRetention(agentId), res),
  });
  const saving = save.isPending;

  const parsedKey = useMemo(() => parseRetentionField(agKey, "agent"), [agKey]);
  const parsedWin = useMemo(() => parseRetentionField(agWin, "agent"), [agWin]);
  const parsedUrl = useMemo(() => parseRetentionField(agUrl, "agent"), [agUrl]);
  const hasRetentionErrors = !!parsedKey.error || !!parsedWin.error || !!parsedUrl.error;

  const saveOverrides = () => {
    if (!isAdmin) return;
    setFormError(null);
    save.reset();
    let body: RetentionPolicy;
    try {
      body = {
        keylog_days: fieldToDays(agKey, "agent"),
        window_days: fieldToDays(agWin, "agent"),
        url_days: fieldToDays(agUrl, "agent"),
      };
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      return;
    }
    save.mutate(body);
  };

  const clearOverrides = () => {
    if (!isAdmin) return;
    setFormError(null);
    save.mutate(null);
  };

  const error = formError ?? (save.error ? String(save.error) : retentionQuery.error ? String(retentionQuery.error) : null);
  const ok = save.isSuccess ? (save.variables ? "Saved." : "Using defaults.") : null;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Retention overrides</CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        {retentionQuery.isPending ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner /> Loading retention…
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {!isAdmin && (
              <Alert>
                <AlertDescription>Admin only.</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {ok && (
              <Alert>
                <AlertDescription className="text-success">{ok}</AlertDescription>
              </Alert>
            )}

            {agGlobal ? (
              <KeyValues
                items={[
                  { label: "Default keylogs", value: fmtRetentionBrief(agGlobal.keylog_days) },
                  { label: "Default windows", value: fmtRetentionBrief(agGlobal.window_days) },
                  { label: "Default URLs", value: fmtRetentionBrief(agGlobal.url_days) },
                  { label: "Keylogs", value: effective(agKey, parsedKey, agGlobal.keylog_days) },
                  { label: "Windows", value: effective(agWin, parsedWin, agGlobal.window_days) },
                  { label: "URLs", value: effective(agUrl, parsedUrl, agGlobal.url_days) },
                ]}
              />
            ) : null}

            <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
              <RetentionOverrideField
                title="Keylogs"
                value={agKey}
                onChange={(value) => setFields((prev) => ({ ...prev, agKey: value }))}
                globalDays={agGlobal?.keylog_days}
                parsed={parsedKey}
                formDisabled={saving || !isAdmin}
              />
              <RetentionOverrideField
                title="Windows"
                value={agWin}
                onChange={(value) => setFields((prev) => ({ ...prev, agWin: value }))}
                globalDays={agGlobal?.window_days}
                parsed={parsedWin}
                formDisabled={saving || !isAdmin}
              />
              <RetentionOverrideField
                title="URLs"
                value={agUrl}
                onChange={(value) => setFields((prev) => ({ ...prev, agUrl: value }))}
                globalDays={agGlobal?.url_days}
                parsed={parsedUrl}
                formDisabled={saving || !isAdmin}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button disabled={saving || hasRetentionErrors || !isAdmin} onClick={saveOverrides}>
                {saving && <Spinner />} Save
              </Button>
              <Button variant="outline" disabled={saving || !isAdmin} onClick={clearOverrides}>
                Clear overrides
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
