import { useState } from "react";
import { ListFilter, RefreshCw, Trash2 } from "lucide-react";
import { isApiError } from "@/api";
import { useDnsStatus, useRefreshDnsList } from "@/api/queries/dnsManagement";
import {
  DNS_LIMITS,
  validateDnsSource,
  type DnsFieldError,
} from "@/api/dnsManagementValidation";
import type {
  DnsDesiredView,
  DnsGatewayStatus,
  DnsListFormat,
  DnsOperation,
  DnsRefreshResult,
  DnsSourceStatus,
  DnsSubscriptionSource,
} from "@/api/types";
import { Switch } from "@/components/common/SettingsSwitch";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import { FormDialog } from "@/features/network/household/FormDialog";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { DnsBasisGuard, DotText, Field } from "./dnsManagementShared";
import { usePinnedBasis } from "./dnsEditor";
import { errorAt, formatSecs, type DnsEditor } from "./dnsEditor";

const FORMAT_LABEL: Record<DnsListFormat, string> = { hosts: "Hosts", abp: "Adblock (ABP)" };

const FORMAT_HELP =
  "Supported: hosts files, bare-domain and wildcard lists, and Adblock-style domain anchors (||example.com^) with @@ exceptions and $important. Not supported: regular expressions, and context, path or cosmetic rules. Rules this server cannot read are ignored, so a list is not guaranteed to be enforced in full.";

const PROVENANCE_HELP =
  "Declared by you. Vantyr does not verify the publisher or licence, and a declaration is not a compliance check. Choose Unspecified when you do not know.";

/* ---------------------------------------------------------------- status */

function sourceStatusFor(statuses: DnsGatewayStatus[] | undefined, id: string) {
  if (!statuses) return { kind: "loading" as const };
  if (statuses.length === 0) return { kind: "none" as const };
  if (statuses.length > 1) return { kind: "many" as const };
  const gateway = statuses[0]!;
  if (!gateway.status) return { kind: "none" as const };
  const source = gateway.status.sources.find((s) => s.id === id);
  return source
    ? { kind: "one" as const, source, reportedVersion: gateway.status.config_version }
    : { kind: "unreported" as const, reportedVersion: gateway.status.config_version };
}

function DownloadText({ source }: { source: DnsSourceStatus }) {
  const rules = source.rule_count != null ? ` · ${source.rule_count.toLocaleString()} rules` : "";
  const fetched = source.fetched_at ? (
    <>
      {" · fetched "}
      <TimeAgo iso={source.fetched_at} />
    </>
  ) : null;
  const error = source.last_error ? (
    <span className="ml-1 text-muted-foreground" title={source.last_error}>
      · {source.last_error.length > 80 ? `${source.last_error.slice(0, 80)}…` : source.last_error}
    </span>
  ) : null;
  switch (source.download) {
    case "fresh":
      return (
        <DotText tone="success">
          <span>
            Fresh{rules}
            {fetched}
          </span>
        </DotText>
      );
    case "stale":
      return (
        <DotText tone="warning">
          <span>
            Stale{rules}
            {fetched}
          </span>
        </DotText>
      );
    case "failed_with_last_good":
      return (
        <DotText tone="warning">
          <span>
            Last fetch failed, using the last good copy{rules}
            {fetched}
            {error}
          </span>
        </DotText>
      );
    case "never_fetched":
      return <DotText tone="muted">Not fetched yet</DotText>;
    case "disabled":
      return <DotText tone="muted">Disabled</DotText>;
    case "quarantined":
      return (
        <DotText tone="destructive">
          <span>
            Quarantined{error}
          </span>
        </DotText>
      );
    default:
      return (
        <DotText tone="destructive">
          <span>
            No usable copy{error}
          </span>
        </DotText>
      );
  }
}

function RowStatus({
  statuses,
  source,
  desiredVersion,
}: {
  statuses: DnsGatewayStatus[] | undefined;
  source: DnsSubscriptionSource;
  desiredVersion: number;
}) {
  const s = sourceStatusFor(statuses, source.id);
  switch (s.kind) {
    case "loading":
      return null;
    case "none":
      return <span className="text-muted-foreground">No gateway report yet</span>;
    case "many":
      return <span className="text-muted-foreground">See delivery status</span>;
    case "unreported":
      return (
        <span className="text-muted-foreground">
          Not in the gateway’s last report (version {s.reportedVersion})
        </span>
      );
    case "one":
      return (
        <>
          <DownloadText source={s.source} />
          {s.reportedVersion !== desiredVersion ? (
            <span className="ml-2 text-muted-foreground">
              · reported for version {s.reportedVersion}
            </span>
          ) : null}
        </>
      );
  }
}

/* ---------------------------------------------------------------- form */

interface ListDraft {
  id: string;
  url: string;
  format: DnsListFormat;
  enabled: boolean;
  interval: string;
  maxStale: string;
  title: string;
  publisher: string;
  license: string;
}

const EMPTY_DRAFT: ListDraft = {
  id: "",
  url: "",
  format: "hosts",
  enabled: true,
  interval: "",
  maxStale: "",
  title: "",
  publisher: "",
  license: "",
};

function draftOf(source: DnsSubscriptionSource): ListDraft {
  return {
    id: source.id,
    url: source.url,
    format: source.format,
    enabled: source.enabled,
    interval: source.interval_secs != null ? String(source.interval_secs) : "",
    maxStale: source.max_stale_secs != null ? String(source.max_stale_secs) : "",
    title: source.metadata.title,
    publisher: source.metadata.publisher,
    license: source.metadata.license,
  };
}

/** Blank means "use the server default"; anything else is parsed and left to the validators. */
function parseSecs(raw: string): number | null {
  const t = raw.trim();
  return t === "" ? null : Number(t);
}

function sourceOf(d: ListDraft): DnsSubscriptionSource {
  const interval = parseSecs(d.interval);
  const maxStale = parseSecs(d.maxStale);
  return {
    id: d.id.trim(),
    url: d.url.trim(),
    format: d.format,
    enabled: d.enabled,
    ...(interval != null ? { interval_secs: interval } : {}),
    ...(maxStale != null ? { max_stale_secs: maxStale } : {}),
    metadata: { title: d.title.trim(), publisher: d.publisher.trim(), license: d.license.trim() },
  };
}

function SecsField({
  id,
  label,
  value,
  onChange,
  error,
  fallback,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  fallback: number;
}) {
  const n = parseSecs(value);
  return (
    <Field
      label={label}
      id={id}
      error={error}
      hint={
        n != null && Number.isInteger(n) && n > 0
          ? `About ${formatSecs(n)}`
          : `Seconds. Leave empty for the default (${formatSecs(fallback)}).`
      }
    >
      <Input
        id={id}
        inputMode="numeric"
        value={value}
        placeholder={String(fallback)}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function ProvenanceField({
  id,
  label,
  value,
  onChange,
  error,
  help,
  unspecified,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  help?: boolean;
  unspecified?: boolean;
}) {
  return (
    <Field label={label} id={id} error={error} help={help ? PROVENANCE_HELP : undefined}>
      <div className="flex gap-2">
        <Input id={id} value={value} maxLength={DNS_LIMITS.maxTextLen} onChange={(e) => onChange(e.target.value)} />
        {unspecified ? (
          <Button type="button" variant="outline" onClick={() => onChange("Unspecified")}>
            Unspecified
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

function ListFormFields({
  draft,
  setDraft,
  errors,
  mode,
}: {
  draft: ListDraft;
  setDraft: (next: ListDraft) => void;
  errors: DnsFieldError[];
  mode: "add" | "edit";
}) {
  const set = <K extends keyof ListDraft>(key: K, value: ListDraft[K]) => setDraft({ ...draft, [key]: value });
  const err = (key: string) => errorAt(errors, `source.${key}`);
  const show = (key: string, value: string) => (value.length > 0 ? err(key) : null);
  const p = mode;
  return (
    <div className="grid max-h-[60vh] gap-4 overflow-y-auto pr-1">
      {mode === "add" ? (
        <>
          <Field label="Id" id={`${p}-list-id`} error={show("id", draft.id)} hint="Letters, digits, _ and -. It cannot be changed later.">
            <Input id={`${p}-list-id`} value={draft.id} maxLength={DNS_LIMITS.maxSourceIdLen} onChange={(e) => set("id", e.target.value)} />
          </Field>
          <Field
            label="URL"
            id={`${p}-list-url`}
            error={show("url", draft.url)}
            hint="HTTPS only, no username, query or fragment. Use a raw file URL, not a GitHub page."
          >
            <Input id={`${p}-list-url`} value={draft.url} placeholder="https://" onChange={(e) => set("url", e.target.value)} />
          </Field>
          <Field label="Format" id={`${p}-list-format`} help={FORMAT_HELP}>
            <Select value={draft.format} onValueChange={(v) => set("format", v as DnsListFormat)}>
              <SelectTrigger id={`${p}-list-format`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hosts">{FORMAT_LABEL.hosts}</SelectItem>
                <SelectItem value="abp">{FORMAT_LABEL.abp}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          The URL, id and format cannot be edited. Remove and add a new list to change the URL.
        </p>
      )}
      <div className="flex items-center justify-between gap-4 text-sm">
        <label htmlFor={`${p}-list-enabled`}>Enabled</label>
        <Switch id={`${p}-list-enabled`} checked={draft.enabled} onCheckedChange={(c) => set("enabled", c)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SecsField
          id={`${p}-list-interval`}
          label="Refresh every"
          value={draft.interval}
          onChange={(v) => set("interval", v)}
          error={err("interval_secs")}
          fallback={DNS_LIMITS.defaultIntervalSecs}
        />
        <SecsField
          id={`${p}-list-stale`}
          label="Keep a copy for up to"
          value={draft.maxStale}
          onChange={(v) => set("maxStale", v)}
          error={err("max_stale_secs")}
          fallback={DNS_LIMITS.defaultMaxStaleSecs}
        />
      </div>
      <ProvenanceField id={`${p}-list-title`} label="Title" value={draft.title} onChange={(v) => set("title", v)} error={show("metadata.title", draft.title)} />
      <ProvenanceField id={`${p}-list-publisher`} label="Publisher" help unspecified value={draft.publisher} onChange={(v) => set("publisher", v)} error={show("metadata.publisher", draft.publisher)} />
      <ProvenanceField id={`${p}-list-license`} label="Licence" unspecified value={draft.license} onChange={(v) => set("license", v)} error={show("metadata.license", draft.license)} />
    </div>
  );
}

function AddListDialog({
  editor,
  desired,
}: {
  editor: DnsEditor;
  desired: DnsDesiredView | null;
}) {
  const [draft, setDraft] = useState<ListDraft>(EMPTY_DRAFT);
  const { pinned, basis, stale, pin } = usePinnedBasis(desired, editor);
  const existing = pinned?.config.sources ?? [];
  const source = sourceOf(draft);
  const errors = validateDnsSource(source);
  if (existing.some((s) => s.id === source.id)) {
    // Client-side convenience only; the server decides (identical source is a no-op, a different one 409s).
    errors.push({ path: "source.id", message: "A list with this id already exists" });
  }
  const full = existing.length >= DNS_LIMITS.maxSources;
  return (
    <FormDialog
      trigger="Add list"
      title="Add a filter list"
      description="Gateways download the list themselves from this URL."
      submitLabel="Add list"
      canSubmit={errors.length === 0 && !stale}
      disabledReason={full ? `At most ${DNS_LIMITS.maxSources} lists are allowed.` : undefined}
      onSubmit={async () => {
        const result = await editor.submit([{ op: "add_list", source }], basis);
        return result.changed ? undefined : { notice: "No changes" };
      }}
      onReset={() => setDraft(EMPTY_DRAFT)}
    >
      <DnsBasisGuard
        stale={stale}
        onOpen={() => {
          pin();
          setDraft(EMPTY_DRAFT);
        }}
        onReload={editor.reload}
      />
      <ListFormFields draft={draft} setDraft={setDraft} errors={errors} mode="add" />
    </FormDialog>
  );
}

function EditListDialog({
  editor,
  desired,
  source,
}: {
  editor: DnsEditor;
  desired: DnsDesiredView | null;
  source: DnsSubscriptionSource;
}) {
  const [draft, setDraft] = useState<ListDraft>(() => draftOf(source));
  const { pinned, basis, stale, pin } = usePinnedBasis(desired, editor);
  const errors = validateDnsSource(sourceOf(draft));
  // Diff against the snapshot the dialog opened with, not whatever the query shows now.
  const stored = draftOf(pinned?.config.sources.find((s) => s.id === source.id) ?? source);
  const patch: Extract<DnsOperation, { op: "set_list" }>["patch"] = {};
  if (draft.enabled !== stored.enabled) patch.enabled = draft.enabled;
  if (draft.interval.trim() !== stored.interval) patch.interval_secs = parseSecs(draft.interval);
  if (draft.maxStale.trim() !== stored.maxStale) patch.max_stale_secs = parseSecs(draft.maxStale);
  if (
    draft.title.trim() !== stored.title ||
    draft.publisher.trim() !== stored.publisher ||
    draft.license.trim() !== stored.license
  ) {
    patch.metadata = { title: draft.title.trim(), publisher: draft.publisher.trim(), license: draft.license.trim() };
  }
  const changed = Object.keys(patch).length > 0;
  return (
    <FormDialog
      edit
      trigger="Edit"
      title={`Edit ${source.metadata.title}`}
      submitLabel="Save"
      canSubmit={errors.length === 0 && changed && !stale}
      onSubmit={async () => {
        const result = await editor.submit([{ op: "set_list", id: source.id, patch }], basis);
        return result.changed ? undefined : { notice: "No changes" };
      }}
      onReset={() => setDraft(draftOf(source))}
    >
      <DnsBasisGuard
        stale={stale}
        onOpen={() => {
          pin();
          setDraft(draftOf(source));
        }}
        onReload={editor.reload}
      />
      <ListFormFields draft={draft} setDraft={setDraft} errors={errors} mode="edit" />
    </FormDialog>
  );
}

/* ---------------------------------------------------------------- rows */

type RefreshNote = { kind: "ok"; result: DnsRefreshResult } | { kind: "error"; message: string };

function ListRow({
  source,
  editor,
  statuses,
  desiredVersion,
  desired,
  refreshing,
  note,
  onRefresh,
}: {
  source: DnsSubscriptionSource;
  editor: DnsEditor;
  statuses: DnsGatewayStatus[] | undefined;
  desiredVersion: number;
  desired: DnsDesiredView | null;
  refreshing: boolean;
  note: RefreshNote | undefined;
  onRefresh: () => void;
}) {
  const interval = source.interval_secs ?? DNS_LIMITS.defaultIntervalSecs;
  const stale = source.max_stale_secs ?? DNS_LIMITS.defaultMaxStaleSecs;
  const { title, publisher, license } = source.metadata;
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[0.8125rem] text-muted-foreground">
          {publisher} · {license}
        </div>
        <div className="text-[0.8125rem] text-muted-foreground">
          {FORMAT_LABEL[source.format]} · every {formatSecs(interval)} · keeps a copy up to {formatSecs(stale)}
        </div>
        <div className="text-[0.8125rem]">
          <RowStatus statuses={statuses} source={source} desiredVersion={desiredVersion} />
        </div>
        {note ? (
          <div role="status" className={`text-[0.8125rem] ${note.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>
            {note.kind === "error" ? (
              note.message
            ) : (
              <>
                {note.result.created ? "Refresh requested" : "A refresh was already requested"}, expires{" "}
                <TimeAgo iso={note.result.expires_at} />. The gateway checks about once a minute; this does not
                mean the list was downloaded.
              </>
            )}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Switch
          aria-label={`${title} enabled`}
          checked={source.enabled}
          disabled={editor.busy || editor.conflict}
          onCheckedChange={(checked) =>
            void editor.run([{ op: "set_list", id: source.id, patch: { enabled: checked } }], desiredVersion)
          }
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!source.enabled || refreshing}
          title={source.enabled ? undefined : "Enable this list to refresh it"}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} /> Refresh
        </Button>
        <EditListDialog key={source.id} editor={editor} desired={desired} source={source} />
        <HoldAction
          ariaLabel={`Hold to remove ${title}`}
          doneLabel="Removing"
          icon={<Trash2 />}
          disabled={editor.busy || editor.conflict}
          onHold={() => void editor.run([{ op: "remove_list", id: source.id }], desiredVersion)}
        >
          Hold to remove
        </HoldAction>
      </div>
    </div>
  );
}

/** Filter-list subscriptions. A saved list is a proposal: gateways download and apply it themselves. */
export function DnsListsCard({
  householdId,
  desired,
  editor,
}: {
  householdId: string;
  desired: DnsDesiredView | null;
  editor: DnsEditor;
}) {
  const status = useDnsStatus(householdId);
  const refresh = useRefreshDnsList(householdId);
  const [notes, setNotes] = useState<Record<string, RefreshNote>>({});
  const sources = desired?.config.sources ?? [];

  const requestRefresh = (id: string) => {
    refresh.mutate(id, {
      onSuccess: (result) => setNotes((n) => ({ ...n, [id]: { kind: "ok", result } })),
      onError: (e) =>
        setNotes((n) => ({
          ...n,
          [id]: {
            kind: "error",
            // Server text verbatim (404 unknown list, 409 disabled), including any global rate-limit message.
            message:
              isApiError(e) && e.status === 429 && e.retryAfterSecs != null
                ? `${e.message} Try again in ${e.retryAfterSecs} seconds.`
                : e instanceof Error
                  ? e.message
                  : "Request failed",
          },
        })),
    });
  };

  return (
    <SettingsSection
      title="Filter lists"
      icon={<ListFilter />}
      help="Lists are downloaded by the gateway on a schedule. Saving here records what you want; only a gateway report says what it downloaded and applied. The config version is its own counter, not the policy revision."
      action={
        <>
          <span className="text-[0.8125rem] text-muted-foreground">
            {desired ? `Version ${desired.config_version} · Saved` : "Nothing saved yet"}
          </span>
          {sources.length > 0 ? <AddListDialog editor={editor} desired={desired} /> : null}
        </>
      }
    >
      {sources.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-sm text-muted-foreground">No lists configured yet.</p>
          <AddListDialog editor={editor} desired={desired} />
        </div>
      ) : (
        sources.map((source) => (
          <ListRow
            key={source.id}
            source={source}
            editor={editor}
            statuses={status.data?.gateways}
            desiredVersion={desired?.config_version ?? 0}
            desired={desired}
            refreshing={refresh.isPending && refresh.variables === source.id}
            note={notes[source.id]}
            onRefresh={() => requestRefresh(source.id)}
          />
        ))
      )}
    </SettingsSection>
  );
}
