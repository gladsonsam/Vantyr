import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { NetworkAuditRow } from "@/api/types";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { formatAuditAction, formatAuditDetail } from "@/features/logs/auditDetail";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { cn, fmtDateTimePrecise } from "@/lib/utils";

const STATUS_DOT: Record<string, string> = {
  ok: "bg-primary",
  error: "bg-destructive",
  rejected: "bg-warning",
};

/** One household audit record: dot, title, muted meta, relative time, and its detail on demand. */
export function AuditRow({ row }: { row: NetworkAuditRow }) {
  const detailId = useId();
  const [open, setOpen] = useState(false);
  const title = formatAuditAction(row.action);
  const { pairs } = formatAuditDetail(row.action, row.detail);
  const meta = [row.actor, row.client_ip].filter((part): part is string => Boolean(part));
  return (
    <li className="relative flex flex-col gap-1 border-b border-border/60 py-3 pr-4 pl-10 last:border-b-0">
      <span
        aria-hidden
        className={cn(
          "absolute top-[1.15rem] left-4 size-2 rounded-full",
          STATUS_DOT[row.status.toLowerCase()] ?? "bg-muted-foreground/50",
        )}
      />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline justify-between gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="min-w-0 break-words font-medium">{title}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <TimeAgo iso={row.ts} />
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 transition-transform motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </span>
      </button>
      <p className="text-xs text-muted-foreground">{meta.join(" · ")}</p>
      {open ? (
        <div id={detailId} className="mt-2">
          <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
            <KeyValueCard label="When" format="text">
              {fmtDateTimePrecise(row.ts)}
            </KeyValueCard>
            <KeyValueCard label="Status" format="text">
              {row.status}
            </KeyValueCard>
            <KeyValueCard label="Record" format="code">
              #{row.id}
            </KeyValueCard>
            {pairs.map((pair) => (
              <KeyValueCard key={pair.label} label={pair.label} format="text">
                {pair.value}
              </KeyValueCard>
            ))}
          </KeyValueGrid>
        </div>
      ) : null}
    </li>
  );
}
