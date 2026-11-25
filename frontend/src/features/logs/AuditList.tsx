import { Fragment, type Ref } from "react";
import { ListPagination } from "@/components/common/ListPagination";
import { fmtDayLabel, parseTimestamp } from "@/lib/utils";
import { AuditRowItem } from "./AuditRowItem";
import type { AuditRow } from "./auditRows";

interface AuditListProps {
  rows: AuditRow[];
  title: string;
  newestFirst: boolean;
  nameOf: (agentId: string | null) => string | null;
  showActor: boolean;
  showDevice: boolean;
  page: number;
  pages: number;
  onPage: (page: number) => void;
  /** The rows belong to the previous filter while the new one loads. */
  stale: boolean;
  listRef: Ref<HTMLDivElement>;
}

function dayOf(row: AuditRow): { key: string; label: string } {
  const date = parseTimestamp(row.ts);
  return date ? { key: date.toDateString(), label: fmtDayLabel(date) } : { key: "unknown", label: "Unknown date" };
}

/** The current page of records under one heading per day, with paging. */
export function AuditList({ rows, title, newestFirst, nameOf, showActor, showDevice, page, pages, onPage, stale, listRef }: AuditListProps) {
  const days: { key: string; label: string; rows: AuditRow[] }[] = [];
  for (const row of rows) {
    const day = dayOf(row);
    const last = days[days.length - 1];
    if (last?.key === day.key) last.rows.push(row);
    else days.push({ ...day, rows: [row] });
  }
  return (
    <div ref={listRef} tabIndex={-1} aria-busy={stale} className={`scroll-mt-20 overflow-hidden outline-none rounded-xl bg-card ${stale ? "opacity-60" : ""}`}>
      {days.map((day) => (
        <Fragment key={day.key}>
          <h3 className="bg-muted/40 px-4 py-1.5 text-xs font-medium text-muted-foreground">{day.label}</h3>
          <ul aria-label={`${title}, ${day.label}, ${newestFirst ? "newest" : "oldest"} first`}>
            {day.rows.map((row) => (
              <AuditRowItem
                key={row.id}
                row={row}
                deviceName={nameOf(row.agent_id)}
                showActor={showActor}
                showDevice={showDevice}
              />
            ))}
          </ul>
        </Fragment>
      ))}
      <ListPagination page={page} pages={pages} onPageChange={onPage} />
    </div>
  );
}
