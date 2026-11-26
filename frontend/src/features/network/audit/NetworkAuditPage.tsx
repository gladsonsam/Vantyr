import { Fragment, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ScrollText, Search } from "lucide-react";
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
import { networkQueries } from "@/api/queries/network";
import type { NetworkAuditRow } from "@/api/types";
import { EmptyState } from "@/components/common/EmptyState";
import { HelpTip } from "@/components/common/HelpTip";
import { useNetworkHousehold } from "@/features/network/access/networkScope";
import { PageLoading } from "@/features/network/components/PageLoading";
import { QueryError } from "@/features/network/components/QueryError";
import { formatAuditAction } from "@/features/logs/auditDetail";
import { SettingsPageHeader } from "@/features/settings/components/SettingsLayout";
import { fmtDayLabel, parseTimestamp } from "@/lib/utils";
import { AuditRow } from "./AuditRow";

const PAGE_SIZE = 50;
const ALL = "all";

function dayOf(row: NetworkAuditRow): { key: string; label: string } {
  const date = parseTimestamp(row.ts);
  return date
    ? { key: date.toDateString(), label: fmtDayLabel(date) }
    : { key: "unknown", label: "Unknown date" };
}

/**
 * This household’s audit trail, newest first. The server only pages (limit/offset), so search and
 * the action filter apply to the pages loaded so far.
 */
export function NetworkAuditPage() {
  const household = useNetworkHousehold();
  const [pageCount, setPageCount] = useState(1);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState(ALL);

  const pages = useQueries({
    queries: Array.from({ length: pageCount }, (_, i) =>
      networkQueries.audit(household.id, { limit: PAGE_SIZE, offset: i * PAGE_SIZE }),
    ),
  });
  const first = pages[0];
  const last = pages[pages.length - 1];
  const rows = pages.flatMap((page) => page.data?.rows ?? []);
  const actions = [...new Set(rows.map((row) => row.action))].sort();

  const needle = search.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (action !== ALL && row.action !== action) return false;
    if (!needle) return true;
    return (
      row.actor.toLowerCase().includes(needle) ||
      row.action.toLowerCase().includes(needle) ||
      formatAuditAction(row.action).toLowerCase().includes(needle)
    );
  });

  const days: { key: string; label: string; rows: NetworkAuditRow[] }[] = [];
  for (const row of filtered) {
    const day = dayOf(row);
    const tail = days[days.length - 1];
    if (tail?.key === day.key) tail.rows.push(row);
    else days.push({ ...day, rows: [row] });
  }

  const header = (
    <SettingsPageHeader
      title={
        <span className="flex items-center gap-2">
          Audit
          <HelpTip label="About the audit">
            Changes made to this household, newest first. The server pages the list, so search and
            the action filter only look at what has been loaded.
          </HelpTip>
        </span>
      }
      description="Who changed what in this household."
    />
  );

  if (first.isPending) return <PageLoading />;
  if (first.isError) {
    return (
      <div className="space-y-8">
        {header}
        <QueryError
          title="Audit"
          error={first.error}
          scope="network_events"
          onRetry={() => void first.refetch()}
        />
      </div>
    );
  }

  const hasMore = !last.isError && (last.data?.rows.length ?? 0) >= PAGE_SIZE;
  return (
    <div className="space-y-6">
      {header}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search action or actor"
            aria-label="Search the audit"
            className="pl-9"
          />
        </div>
        <Select value={action} onValueChange={(v) => setAction(v as string)}>
          <SelectTrigger className="w-full sm:w-64" aria-label="Filter by action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All actions</SelectItem>
            {actions.map((a) => (
              <SelectItem key={a} value={a}>
                {formatAuditAction(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {days.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? "No audit records yet" : "Nothing matches"}
          description={
            rows.length === 0
              ? "Changes to this household will appear here."
              : hasMore
                ? "Load more to search older records."
                : "Try a different search or action."
          }
          icon={<ScrollText className="size-5" />}
          iconVariant="icon"
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card/10">
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
      {last.isError && pageCount > 1 ? (
        <p role="alert" className="text-center text-sm text-destructive">
          Couldn’t load more records.
        </p>
      ) : null}
      {hasMore || last.isFetching ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={last.isFetching}
            onClick={() => setPageCount((count) => count + 1)}
          >
            {last.isFetching ? <Spinner /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
