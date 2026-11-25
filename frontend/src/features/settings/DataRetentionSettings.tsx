import { useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@vantyr/ui/components/alert-dialog";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import { Spinner } from "@vantyr/ui/components/spinner";
import { errorText } from "@/api";
import { HelpTip } from "@/components/common/HelpTip";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import type { RetentionSettingsForm } from "./hooks/useRetentionSettings";
import { describeRetention, fmtDays, MAX_RETENTION_DAYS, RETENTION_KINDS, type RetentionKey } from "./lib/retention";

function RetentionRow({ form, label, name, disabled }: { form: RetentionSettingsForm; label: string; name: RetentionKey; disabled: boolean }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const parsed = form.parsed![name];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          value={form.fields![name]}
          disabled={disabled}
          aria-invalid={Boolean(parsed.error)}
          aria-describedby={hintId}
          onChange={(event) => form.edit(name, event.target.value)}
          className="h-9"
        />
        <span className="shrink-0 text-muted-foreground">days</span>
      </div>
      <p id={hintId} className={parsed.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {parsed.error ?? describeRetention(parsed, form.saved![name])}
      </p>
    </div>
  );
}

function ShorteningDialog({ form, open, onClose }: { form: RetentionSettingsForm; open: boolean; onClose: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !form.saving) onClose(); }}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete older data automatically?</AlertDialogTitle>
          <AlertDialogDescription>
            These limits are shorter than what is saved now. Data older than the new limit is deleted for good and cannot be recovered.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex flex-col gap-1 text-sm">
          {form.shortened.map(({ key, label }) => (
            <li key={key}>
              <span className="font-medium">{label}:</span> older than {fmtDays(form.parsed![key].days)} (now {fmtDays(form.saved![key])})
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={form.saving}>Keep current limits</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={form.saving}
            onClick={() => {
              form.save();
              onClose();
            }}
          >
            {form.saving && <Spinner />} Save and delete older data
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RetentionNotices({ form }: { form: RetentionSettingsForm }) {
  const { query } = form;
  return (
    <>
      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn&apos;t refresh these limits, so they may be out of date.</span>
            <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {form.saveError && (
        <Alert variant="destructive">
          <AlertDescription>Not saved. {form.saveError}</AlertDescription>
        </Alert>
      )}
      {form.justSaved && !form.saveError && (
        <p role="status" className="text-success">
          Saved.{" "}
          {RETENTION_KINDS.some(({ key }) => form.justSaved![key] != null)
            ? "Data older than these limits is deleted automatically."
            : "Nothing is deleted automatically."}
        </p>
      )}
    </>
  );
}

function RetentionActions({ form, isAdmin, onSave }: { form: RetentionSettingsForm; isAdmin: boolean; onSave: () => void }) {
  if (!isAdmin) return <p className="text-muted-foreground">Only admins can change retention.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={form.saving || form.hasErrors || !form.dirty} onClick={onSave}>
        {form.saving && <Spinner />} Save
      </Button>
      {form.dirty && (
        <Button variant="outline" disabled={form.saving} onClick={form.discard}>
          Discard changes
        </Button>
      )}
      {form.dirty && !form.saving && <span className="text-muted-foreground">Unsaved changes</span>}
    </div>
  );
}

/** The server-wide retention limits: blank or 0 keeps data forever, 1 to 36500 deletes older data automatically. */
export function DataRetentionSettings({ form, isAdmin }: { form: RetentionSettingsForm; isAdmin: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const { query } = form;

  if (query.isPending) {
    return (
      <Card className="gap-0 py-0">
        <CardContent className="flex items-center justify-center gap-2 p-5 py-8 text-sm text-muted-foreground">
          <Spinner /> Loading retention…
        </CardContent>
      </Card>
    );
  }
  // No form without the saved limits: blank boxes would read as "keep forever" and Save would erase the real ones.
  if (!form.saved || !form.fields || !form.parsed) {
    return (
      <LoadFailedCard
        message={query.error ? `Couldn't load data retention. ${errorText(query.error)}` : "Data retention is unavailable."}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const limited = RETENTION_KINDS.filter(({ key }) => form.saved![key] != null).length;
  const summary = limited === 0 ? "Nothing is deleted automatically" : `${limited} of ${RETENTION_KINDS.length} kinds of data deleted after a set time`;
  const locked = !isAdmin || form.saving;
  const save = () => (form.shortened.length > 0 ? setConfirming(true) : form.save());

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="flex items-center gap-1.5">
          Data retention
          <HelpTip>
            Days to keep raw rows, from 1 to {MAX_RETENTION_DAYS}; blank or 0 keeps them forever. Top URL and window totals are kept
            separately. Individual devices can override these from their own Settings tab.
          </HelpTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-5 pb-5 text-sm">
        <p className="text-muted-foreground">{summary}. Blank or 0 keeps data forever.</p>
        <RetentionNotices form={form} />
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {RETENTION_KINDS.map(({ key, label }) => (
            <RetentionRow key={key} form={form} name={key} label={label} disabled={locked} />
          ))}
        </div>
        <RetentionActions form={form} isAdmin={isAdmin} onSave={save} />
      </CardContent>
      <ShorteningDialog form={form} open={confirming} onClose={() => setConfirming(false)} />
    </Card>
  );
}
