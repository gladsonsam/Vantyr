import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/api";
import { settingsKeys, settingsQueries } from "@/api/queries/settings";
import type { RetentionPolicy } from "@/api/types";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import { Spinner } from "@vantyr/ui/components/spinner";
import { useServerDraft } from "@/hooks/useServerDraft";
import {
  daysToField,
  describeRetentionField,
  fieldToDays,
  parseRetentionField,
  retentionDefaultPlaceholder,
} from "./retentionForm";

type RetentionKey = keyof RetentionPolicy;
type RetentionFields = Record<RetentionKey, string>;

/** Labelled like the tools that show the data, so "Websites" here is the Websites tool. */
const KINDS: { key: RetentionKey; label: string }[] = [
  { key: "keylog_days", label: "Keystrokes" },
  { key: "window_days", label: "App windows" },
  { key: "url_days", label: "Websites" },
];

const NO_RETENTION_FIELDS: RetentionFields = { keylog_days: "", window_days: "", url_days: "" };

function toRetentionFields({ override }: { override: RetentionPolicy | null }): RetentionFields {
  return {
    keylog_days: daysToField(override?.keylog_days, "agent"),
    window_days: daysToField(override?.window_days, "agent"),
    url_days: daysToField(override?.url_days, "agent"),
  };
}

function sameFields(a: RetentionFields, b: RetentionFields) {
  return KINDS.every(({ key }) => a[key].trim() === b[key].trim());
}

function RetentionRow({
  label,
  value,
  onChange,
  globalDays,
  error,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  globalDays: number | null | undefined;
  error: string | null;
  disabled: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {value.trim() !== "" && !disabled && (
          <Button type="button" variant="ghost" size="xs" className="pointer-coarse:h-9" aria-label={`Use the default for ${label}`} onClick={() => onChange("")}>
            Use default
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          value={value}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
          placeholder={retentionDefaultPlaceholder(globalDays)}
          className="h-9"
        />
        <span className="shrink-0 text-muted-foreground">days</span>
      </div>
      <p id={hintId} className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {error ?? describeRetentionField(value, globalDays)}
      </p>
    </div>
  );
}

function useRetentionForm(agentId: string, isAdmin: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery(settingsQueries.agentRetention(agentId));

  // Override fields are edited locally; every fresh server copy (load or save) re-seeds them.
  const [fields, setFields] = useServerDraft(query.data, query.dataUpdatedAt, toRetentionFields, NO_RETENTION_FIELDS);
  const saved = query.data ? toRetentionFields(query.data) : NO_RETENTION_FIELDS;
  const [formError, setFormError] = useState<string | null>(null);

  /** `null` clears the overrides. */
  const save = useMutation({
    mutationFn: (body: RetentionPolicy | null) =>
      body ? api.retentionAgentPut(agentId, body) : api.retentionAgentDelete(agentId),
    onSuccess: (res) => queryClient.setQueryData(settingsKeys.agentRetention(agentId), res),
  });

  const parsed = useMemo(
    () => ({
      keylog_days: parseRetentionField(fields.keylog_days, "agent"),
      window_days: parseRetentionField(fields.window_days, "agent"),
      url_days: parseRetentionField(fields.url_days, "agent"),
    }),
    [fields],
  );

  const settle = () => {
    setFormError(null);
    if (save.isSuccess) save.reset();
  };

  const failure = save.error ?? query.error;
  return {
    query,
    fields,
    parsed,
    dirty: !sameFields(fields, saved),
    hasErrors: KINDS.some(({ key }) => parsed[key].error),
    saving: save.isPending,
    error: formError ?? (failure ? errorText(failure) : null),
    message: save.isSuccess ? (save.variables ? "Saved." : "Using the defaults.") : null,
    edit: (key: RetentionKey, value: string) => {
      settle();
      setFields((prev) => ({ ...prev, [key]: value }));
    },
    discard: () => {
      settle();
      setFields(saved);
    },
    saveOverrides: () => {
      if (!isAdmin) return;
      setFormError(null);
      save.reset();
      try {
        save.mutate({
          keylog_days: fieldToDays(fields.keylog_days, "agent"),
          window_days: fieldToDays(fields.window_days, "agent"),
          url_days: fieldToDays(fields.url_days, "agent"),
        });
      } catch (e) {
        setFormError(e instanceof Error ? e.message : String(e));
      }
    },
    clearOverrides: () => {
      if (!isAdmin) return;
      setFormError(null);
      save.mutate(null);
    },
  };
}

type RetentionForm = ReturnType<typeof useRetentionForm>;

function RetentionActions({ form, hasOverride }: { form: RetentionForm; hasOverride: boolean }) {
  const { saving, dirty, hasErrors } = form;
  return (
    <div className="flex flex-wrap gap-2">
      <Button disabled={saving || hasErrors || !dirty} onClick={form.saveOverrides}>
        {saving && <Spinner />} Save
      </Button>
      {dirty && (
        <Button variant="outline" disabled={saving} onClick={form.discard}>
          Discard changes
        </Button>
      )}
      {hasOverride && !dirty && (
        <Button variant="outline" disabled={saving} onClick={form.clearOverrides}>
          Use defaults for all
        </Button>
      )}
    </div>
  );
}

/** Per-agent retention overrides (blank = inherit the default, 0 = unlimited). Admin only. */
export function AgentRetentionCard({ agentId, isAdmin }: { agentId: string; isAdmin: boolean }) {
  const form = useRetentionForm(agentId, isAdmin);
  const { query, fields, parsed, error, message } = form;

  if (query.isPending) {
    return (
      <Card className="gap-0 py-0">
        <CardContent className="flex items-center justify-center gap-2 p-5 py-8 text-sm text-muted-foreground">
          <Spinner /> Loading retention…
        </CardContent>
      </Card>
    );
  }
  // Never show an empty form when the load failed: blank boxes read as "no overrides" and Save would clear them.
  if (!query.data) {
    return (
      <LoadFailedCard
        message={query.error ? errorText(query.error) : "Retention settings are unavailable."}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const { global, override } = query.data;
  const overridden = override ? KINDS.filter(({ key }) => override[key] !== null).length : 0;
  const summary = overridden === 0 ? "Using the default retention" : `${overridden} of ${KINDS.length} set for this device`;

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-5 p-5 text-sm">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-base font-medium">{summary}</h3>
          <p className="text-muted-foreground">Data older than the limit is deleted automatically. Leave a box empty to use the default; 0 keeps it forever.</p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {message && !error && (
          <p role="status" className="text-success">
            {message}
          </p>
        )}

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {KINDS.map(({ key, label }) => (
            <RetentionRow
              key={key}
              label={label}
              value={fields[key]}
              onChange={(value) => form.edit(key, value)}
              globalDays={global[key]}
              error={parsed[key].error}
              disabled={form.saving || !isAdmin}
            />
          ))}
        </div>

        {isAdmin ? (
          <RetentionActions form={form} hasOverride={override !== null} />
        ) : (
          <p className="text-muted-foreground">Only admins can change retention.</p>
        )}
      </CardContent>
    </Card>
  );
}
