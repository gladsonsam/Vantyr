import { ScrollText } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Skeleton } from "@vantyr/ui/components/skeleton";
import { errorText } from "@/api";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { AuditList } from "./AuditList";
import { AuditToolbar } from "./AuditToolbar";
import { AUDIT_LIMIT, type AuditScope } from "./auditRows";
import { auditSummary, emptyMessage } from "./auditSummary";
import { useAuditView } from "./useAuditView";

interface AuditTabProps {
  /** When set, only rows for this agent (same API as global log). */
  agentId?: string;
  /** Narrow global log: authentication-only vs operator/API (ignored when `agentId` is set). */
  scope?: AuditScope;
  /** Accessible name of the list (default: Audit log). */
  title?: string;
}

export function AuditTab({ agentId, scope = "all", title = "Audit log" }: AuditTabProps) {
  const view = useAuditView(agentId, scope);
  const { auditQuery, filters, matching, scoped, hiddenViews } = view;
  const retry = () => void auditQuery.refetch();
  // A failed load has no rows to show, but the filters stay reachable: the failure may belong to the one just chosen.
  const loadFailed = auditQuery.isError && !auditQuery.data;
  const firstLoad = auditQuery.isPending;
  const failure = auditQuery.isError ? errorText(auditQuery.error) : "";

  const summary = firstLoad
    ? "Loading audit log…"
    : auditSummary({
        shown: view.shown.length,
        matching: matching.length,
        scoped: scoped.length,
        page: view.page,
        hiddenViews,
        uniformActor: view.uniformActor,
        capped: view.rows.length >= AUDIT_LIMIT,
        refreshing: auditQuery.isFetching,
        filtering: filters.query.trim() !== "" || filters.status !== "all",
        failed: loadFailed,
      });

  return (
    <div className="flex flex-col gap-4">
      <h2 className="sr-only">{title}</h2>
      <AuditToolbar
        summary={summary}
        query={filters.query}
        onQuery={filters.setQuery}
        status={filters.status}
        onStatus={filters.setStatus}
        showViews={filters.showViews}
        onShowViews={filters.setShowViews}
        newestFirst={filters.newestFirst}
        onToggleOrder={filters.toggleOrder}
        refreshing={auditQuery.isFetching}
        onRefresh={retry}
      />
      {auditQuery.isError && !loadFailed && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span className="min-w-0 break-words">
            Couldn’t refresh the audit log: {failure}. Showing the records from the last successful
            load.
          </span>
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      {loadFailed ? (
        <LoadFailedCard message={`Couldn’t load the audit log: ${failure}`} onRetry={retry} />
      ) : firstLoad ? (
        <Skeleton aria-label="Loading audit log" className="h-64 w-full rounded-xl" />
      ) : matching.length === 0 ? (
        <NoRecords view={view} scope={scope} forDevice={Boolean(agentId)} />
      ) : (
        <AuditList
          rows={view.shown}
          title={title}
          newestFirst={filters.newestFirst}
          nameOf={view.nameOf}
          showActor={view.uniformActor === null}
          showDevice={!agentId}
          page={view.page}
          pages={view.pages}
          onPage={view.goToPage}
          stale={auditQuery.isPlaceholderData}
          listRef={view.listRef}
        />
      )}
    </div>
  );
}

/** Why nothing is listed, and the one control that brings records back. */
function NoRecords({
  view,
  scope,
  forDevice,
}: {
  view: ReturnType<typeof useAuditView>;
  scope: AuditScope;
  forDevice: boolean;
}) {
  const { filters, hiddenViews } = view;
  const empty = emptyMessage({
    query: filters.query,
    status: filters.status,
    scope,
    forDevice,
    hiddenViews,
    loaded: view.rows.length,
  });
  const action = filters.query.trim()
    ? { label: "Clear search", run: () => filters.setQuery("") }
    : filters.status !== "all"
      ? { label: "Show all outcomes", run: () => filters.setStatus("all") }
      : hiddenViews > 0
        ? { label: "Show page views", run: () => filters.setShowViews(true) }
        : null;
  return (
    <EmptyState
      title={empty.title}
      description={empty.description}
      icon={<ScrollText />}
      iconVariant="icon"
      action={
        action ? (
          <Button variant="outline" onClick={action.run}>
            {action.label}
          </Button>
        ) : undefined
      }
    />
  );
}
