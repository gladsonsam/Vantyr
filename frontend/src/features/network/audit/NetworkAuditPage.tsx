import { Fragment, useId, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { isApiError } from "@/api";
import { networkQueries, useAudit } from "@/api/queries/network";
import type { NetworkAuditFilters, NetworkAuditRow } from "@/api/types";
import { EmptyState } from "@/components/common/EmptyState";
import { HelpTip } from "@/components/common/HelpTip";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { PageLoading } from "@/features/network/components/PageLoading";
import { QueryError } from "@/features/network/components/QueryError";
import { useDebouncedCommit } from "@/features/network/lib/useDebouncedCommit";
import { formatAuditAction } from "@/features/logs/auditDetail";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { fmtDayLabel, parseTimestamp } from "@/lib/utils";
import { AuditRow } from "./AuditRow";

const PAGE_SIZES = ["25", "50", "100", "200"] as const;
const MAX_TEXT = 128;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LIMITED_MESSAGE =
  "You’ve reached the end of what can be browsed. Narrow the filters (date range, action or actor) to see older entries.";

function dayOf(row: NetworkAuditRow): { key: string; label: string } {
  const date = parseTimestamp(row.ts);
  return date
    ? { key: date.toDateString(), label: fmtDayLabel(date) }
    : { key: "unknown", label: "Unknown date" };
}

/** An exact-match text filter value, or the reason the server would reject it. */
function textProblem(value: string): string | null {
  if (value.length > MAX_TEXT) return `At most ${MAX_TEXT} characters.`;
  if (CONTROL_CHARS.test(value)) return "Control characters aren’t allowed.";
  return null;
}

/** `datetime-local` value (browser local time) to an RFC3339 UTC instant; null when empty/invalid. */
function toInstant(value: string, endOfMinute: boolean): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfMinute) date.setSeconds(59, 999);
  return date.toISOString();
}

/**
 * This household’s audit trail, newest first. Filters are exact-match and applied by the server
 * (action and actor are the stored strings, not a search), so the total is honest about them.
 */
export function NetworkAuditPage() {
  const household = useNetworkHousehold();
  const ids = useId();

  // Text drafts commit (debounced) into `applied*`; dates and page size apply immediately.
  const [actionDraft, setActionDraft] = useState("");
  const [actorDraft, setActorDraft] = useState("");
  const [appliedAction, setAppliedAction] = useState("");
  const [appliedActor, setAppliedActor] = useState("");
  const [fromValue, setFromValue] = useState("");
  const [toValue, setToValue] = useState("");
  const [pageSize, setPageSize] = useState<string>("50");

  const commitAction = useDebouncedCommit<string>(setAppliedAction);
  const commitActor = useDebouncedCommit<string>(setAppliedActor);

  const actionProblem = textProblem(actionDraft.trim());
  const actorProblem = textProblem(actorDraft.trim());
  const from = toInstant(fromValue, false);
  const to = toInstant(toValue, true);
  const rangeProblem =
    from && to && from > to ? "“From” must be before or equal to “To”." : null;

  const filters = useMemo<NetworkAuditFilters>(() => {
    const next: NetworkAuditFilters = { limit: Number(pageSize) };
    const action = appliedAction.trim();
    const actor = appliedActor.trim();
    if (action && !textProblem(action)) next.action = action;
    if (actor && !textProblem(actor)) next.actor = actor;
    if (!rangeProblem) {
      if (from) next.from = from;
      if (to) next.to = to;
    }
    return next;
  }, [pageSize, appliedAction, appliedActor, from, to, rangeProblem]);
  const filterKey = JSON.stringify(filters);
  const filtered = Boolean(filters.action || filters.actor || filters.from || filters.to);
  const anyInput = Boolean(actionDraft || actorDraft || fromValue || toValue);

  // Later pages, keyed by the filters they were fetched for, so changing a filter resets the list.
  const [more, setMore] = useState<{ key: string; offsets: number[] }>({ key: "", offsets: [] });
  const offsets = more.key === filterKey ? more.offsets : [];

  const first = useAudit(household.id, { ...filters, offset: 0 });
  const extra = useQueries({
    queries: offsets.map((offset) => networkQueries.audit(household.id, { ...filters, offset })),
  });
  const lastExtra = extra[extra.length - 1];
  const lastPage = lastExtra ?? first;

  const rows: NetworkAuditRow[] = [];
  {
    const seen = new Set<number>();
    const lists = [first.data?.rows ?? [], ...extra.map((page) => page.data?.rows ?? [])];
    for (const list of lists) {
      for (const row of list) {
        // Inserts between page fetches can shift rows across a boundary; show each record once.
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
  }
  // Suggestions come from what is loaded now, so they follow the current filters.
  const seenActions = [...new Set(rows.map((row) => row.action))].sort();
  const seenActors = [...new Set(rows.map((row) => row.actor))].sort();

  const clearFilters = () => {
    setActionDraft("");
    setActorDraft("");
    setAppliedAction("");
    setAppliedActor("");
    setFromValue("");
    setToValue("");
  };

  const header = (
    <SettingsPageHeader
      title={
        <span className="flex items-center gap-2">
          Audit
          <HelpTip label="About the audit">
            Changes made to this household, newest first. Action and actor filters are exact
            matches on the stored value (not a search), so “network.policy” won’t match
            “network.policy.saved”. Pick a suggestion or type the full value. Dates are in your
            local time.
          </HelpTip>
        </span>
      }
      description="Who changed what in this household."
    />
  );

  if (first.isPending) return <PageLoading />;
  const status = isApiError(first.error) ? first.error.status : null;
  if (first.isError && !first.data && (status === 403 || status === 404 || status === null || status >= 500)) {
    return (
      <div className="space-y-8">
        {header}
        <QueryError
          title="Audit"
          error={first.error}
          scope="network_admin"
          onRetry={() => void first.refetch()}
        />
      </div>
    );
  }

  const data = first.data;
  const nextOffset = lastPage.data?.next_offset ?? null;
  const limited = Boolean(lastPage.data && nextOffset === null && lastPage.data.pagination_limited);
  const serverMessage =
    first.isError && isApiError(first.error) && first.error.status === 400
      ? first.error.message
      : null;
  const stale = first.isPlaceholderData;

  const days: { key: string; label: string; rows: NetworkAuditRow[] }[] = [];
  for (const row of rows) {
    const day = dayOf(row);
    const tail = days[days.length - 1];
    if (tail?.key === day.key) tail.rows.push(row);
    else days.push({ ...day, rows: [row] });
  }

  const fieldLabel = "text-xs font-medium text-muted-foreground";
  const problemText = "text-xs text-destructive";
  return (
    <div className="space-y-6">
      {header}
      <div className="space-y-4 rounded-xl border border-border/70 bg-card/10 p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-action`} className={fieldLabel}>
              Action (exact)
            </label>
            <Input
              id={`${ids}-action`}
              list={`${ids}-actions`}
              value={actionDraft}
              maxLength={MAX_TEXT}
              placeholder="e.g. network.policy.saved"
              autoComplete="off"
              aria-invalid={Boolean(actionProblem)}
              onChange={(event) => {
                setActionDraft(event.target.value);
                commitAction(event.target.value);
              }}
            />
            <datalist id={`${ids}-actions`}>
              {seenActions.map((value) => (
                <option key={value} value={value} label={formatAuditAction(value)} />
              ))}
            </datalist>
            {actionProblem ? <p className={problemText}>{actionProblem}</p> : null}
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-actor`} className={fieldLabel}>
              Actor (exact)
            </label>
            <Input
              id={`${ids}-actor`}
              list={`${ids}-actors`}
              value={actorDraft}
              maxLength={MAX_TEXT}
              placeholder="Stored actor value"
              autoComplete="off"
              aria-invalid={Boolean(actorProblem)}
              onChange={(event) => {
                setActorDraft(event.target.value);
                commitActor(event.target.value);
              }}
            />
            <datalist id={`${ids}-actors`}>
              {seenActors.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            {actorProblem ? <p className={problemText}>{actorProblem}</p> : null}
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-from`} className={fieldLabel}>
              From
            </label>
            <Input
              id={`${ids}-from`}
              type="datetime-local"
              value={fromValue}
              max={toValue || undefined}
              aria-invalid={Boolean(rangeProblem)}
              onChange={(event) => setFromValue(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-to`} className={fieldLabel}>
              To
            </label>
            <Input
              id={`${ids}-to`}
              type="datetime-local"
              value={toValue}
              min={fromValue || undefined}
              aria-invalid={Boolean(rangeProblem)}
              onChange={(event) => setToValue(event.target.value)}
            />
          </div>
        </div>
        {rangeProblem ? (
          <p role="alert" className={problemText}>
            {rangeProblem}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={fieldLabel}>Per page</span>
            <Select value={pageSize} onValueChange={(value) => setPageSize(value as string)}>
              <SelectTrigger className="w-24" aria-label="Entries per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((size) => (
                  <SelectItem key={size} value={size}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" disabled={!anyInput && !filtered} onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      </div>

      {serverMessage ? (
        <p role="alert" className="rounded-xl border border-destructive/40 px-4 py-3 text-sm text-destructive">
          {serverMessage}
        </p>
      ) : null}

      {data ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Showing {stale ? data.rows.length : rows.length} of {data.total.toLocaleString()}
          {filtered ? " matching entries" : " entries"}
        </p>
      ) : null}

      {days.length === 0 ? (
        serverMessage ? null : (
          <EmptyState
            title={filtered ? "No audit entries match these filters" : "No audit records yet"}
            description={
              filtered
                ? "Action and actor must match the stored value exactly."
                : "Changes to this household will appear here."
            }
            icon={<ScrollText className="size-5" />}
            iconVariant="icon"
            action={
              filtered ? (
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div
          className="overflow-hidden rounded-xl border border-border/70 bg-card/10 data-[stale=true]:opacity-60"
          data-stale={stale}
          aria-busy={stale}
        >
          {days.map((day) => (
            <Fragment key={day.key}>
              <h3 className="border-b border-border/70 px-4 py-2 text-xs font-medium text-muted-foreground">
                {day.label}
              </h3>
              <ul aria-label={`Audit, ${day.label}`}>
                {day.rows.map((row) => (
                  <AuditRow key={row.id} row={row} />
                ))}
              </ul>
            </Fragment>
          ))}
        </div>
      )}

      {lastExtra?.isError ? (
        <div role="alert" className="flex items-center justify-center gap-3 text-sm text-destructive">
          Couldn’t load more records.
          <Button variant="outline" size="sm" onClick={() => void lastExtra.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {limited ? (
        <p className="rounded-xl border border-border/70 px-4 py-3 text-sm text-muted-foreground">
          {LIMITED_MESSAGE}
        </p>
      ) : null}
      {!stale && nextOffset !== null ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={lastPage.isFetching}
            onClick={() => setMore({ key: filterKey, offsets: [...offsets, nextOffset] })}
          >
            {lastPage.isFetching ? <Spinner /> : null}
            Load more
          </Button>
        </div>
      ) : null}
      {lastExtra?.isFetching && !lastExtra.data ? (
        <div className="flex justify-center">
          <Spinner />
        </div>
      ) : null}
    </div>
  );
}
