import { useContext, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { auditQueries, type AuditLogParams } from "@/api/queries/audit";
import { AgentsContext } from "@/app/providers/useAgents";
import {
  AUDIT_LIMIT,
  AUDIT_PAGE_SIZE,
  NO_ROWS,
  matchesAuditRow,
  orderRows,
  pageCount,
  scopeRows,
  toAuditRows,
  type AuditScope,
} from "./auditRows";

/** The audit log request, the filters that narrow it and the one page of records they leave. */
export function useAuditView(agentId: string | undefined, scope: AuditScope) {
  const agents = useContext(AgentsContext)?.agents;
  const [status, setStatus] = useState("all");
  // Opening a page is logged too; those reads bury real actions, so they are opt-in.
  const [showViews, setShowViews] = useState(false);
  const [query, setQuery] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const auditQuery = useQuery({
    ...auditQueries.log({
      limit: AUDIT_LIMIT,
      agent_id: agentId,
      status: status !== "all" ? status : undefined,
    }),
    select: toAuditRows,
    // Keep the current rows up while a new status filter loads (never another agent's rows).
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[2] as AuditLogParams | undefined)?.agent_id === agentId
        ? previous
        : undefined,
  });
  const rows = auditQuery.data ?? NO_ROWS;
  const forDevice = Boolean(agentId);

  const scoped = useMemo(
    () => scopeRows(rows, scope, forDevice, showViews),
    [rows, scope, forDevice, showViews],
  );
  const hiddenViews = useMemo(
    () => (showViews ? 0 : scopeRows(rows, scope, forDevice, true).length - scoped.length),
    [rows, scope, forDevice, showViews, scoped],
  );
  const matching = useMemo(
    () =>
      orderRows(
        scoped.filter((row) =>
          matchesAuditRow(row, query, agents?.[row.agent_id ?? ""]?.name ?? ""),
        ),
        newestFirst,
      ),
    [scoped, query, agents, newestFirst],
  );

  // A page number only means something for the view it was chosen in; any change of view starts at page 1.
  const viewKey = [agentId ?? "", scope, status, showViews, query, newestFirst].join("\u0000");
  const [paging, setPaging] = useState({ key: viewKey, page: 1 });
  if (paging.key !== viewKey) setPaging({ key: viewKey, page: 1 });
  const pages = pageCount(matching.length);
  const page = paging.key === viewKey ? Math.min(paging.page, pages) : 1;
  const shown = matching.slice((page - 1) * AUDIT_PAGE_SIZE, page * AUDIT_PAGE_SIZE);
  const goToPage = (next: number) => {
    setPaging({ key: viewKey, page: next });
    listRef.current?.scrollIntoView?.({ block: "start" });
    // The button just pressed is disabled on the first and last page, which would drop focus to the page body.
    if (next <= 1 || next >= pages) listRef.current?.focus({ preventScroll: true });
  };

  const actors = new Set(matching.map((row) => row.actor));
  return {
    auditQuery,
    rows,
    scoped,
    matching,
    shown,
    hiddenViews,
    page,
    pages,
    goToPage,
    listRef,
    nameOf: (id: string | null) => (id ? (agents?.[id]?.name ?? null) : null),
    uniformActor: matching.length > 1 && actors.size === 1 ? [...actors][0] : null,
    filters: {
      status,
      setStatus,
      showViews,
      setShowViews,
      query,
      setQuery,
      newestFirst,
      toggleOrder: () => setNewestFirst((value) => !value),
    },
  };
}
