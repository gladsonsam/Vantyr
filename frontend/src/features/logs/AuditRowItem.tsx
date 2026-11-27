import { Fragment, useId, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { cn, fmtClock, fmtDateTime, fmtDateTimePrecise } from "@/lib/utils";
import { AuditStatusBadge } from "./AuditStatusBadge";
import { formatAuditAction, formatAuditDetail } from "./auditDetail";
import type { AuditRow } from "./auditRows";

interface AuditRowItemProps {
  row: AuditRow;
  /** The device's name when the fleet knows it, else null. */
  deviceName: string | null;
  /** The device's page, once the device is known. */
  deviceHref: string | null;
  /** Show who did it; false when every record in the list has the same actor. */
  showActor: boolean;
  /** Show the device; false inside one device's own log. */
  showDevice: boolean;
}

const STATUS_DOT: Record<string, string> = {
  ok: "bg-primary",
  error: "bg-destructive",
  rejected: "bg-warning",
};

const TOGGLE_CLASS =
  "group/detail flex min-h-8 w-full items-start gap-1.5 rounded-md py-1 text-left text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-9";

/** One recorded action (under its day heading): what, outcome, when; who, where from and which device; the detail behind one press. */
export function AuditRowItem({
  row,
  deviceName,
  deviceHref,
  showActor,
  showDevice,
}: AuditRowItemProps) {
  const detailId = useId();
  const [open, setOpen] = useState(false);
  const action = formatAuditAction(row.action);
  const { pairs, full } = formatAuditDetail(row.action, row.detail);
  const who = [showActor ? row.actor : null, row.client_ip].filter((part): part is string =>
    Boolean(part),
  );
  const deviceLabel =
    showDevice && row.agent_id ? (deviceName ?? `Device ${row.agent_id.slice(0, 8)}`) : null;

  return (
    <li className="relative flex flex-col gap-1 border-b border-border/60 py-3 pr-4 pl-10 last:border-b-0 hover:bg-muted/40">
      <span
        aria-hidden
        className={cn(
          "absolute top-[1.15rem] left-4 size-2 rounded-full",
          STATUS_DOT[(row.status || "").toLowerCase()] ?? "bg-muted-foreground/50",
        )}
      />
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="min-w-0 break-words font-medium">{action}</span>
          <AuditStatusBadge status={row.status} />
        </div>
        <time
          dateTime={row.ts}
          title={fmtDateTime(row.ts)}
          className="shrink-0 font-sans text-xs text-muted-foreground tabular-nums"
        >
          {fmtClock(row.ts)}
        </time>
      </div>
      {(who.length > 0 || deviceLabel) && (
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          {who.map((part, index) => (
            <Fragment key={part}>
              {index > 0 && <Dot />}
              <span className={cn("min-w-0 break-words", part === row.client_ip && "font-sans")}>
                {part}
              </span>
            </Fragment>
          ))}
          {deviceLabel && deviceHref && (
            <>
              {who.length > 0 && <Dot />}
              <Link
                to={deviceHref}
                className="min-w-0 break-words rounded-sm underline-offset-2 outline-none -my-1.5 py-1.5 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {deviceLabel}
              </Link>
            </>
          )}
        </p>
      )}
      {pairs.length > 0 && (
        <>
          <button
            type="button"
            className={TOGGLE_CLASS}
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="sr-only">Details: </span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words [overflow-wrap:anywhere]",
                !open && "line-clamp-2",
              )}
            >
              {pairs.map((pair, index) => (
                <span key={pair.label}>
                  {index > 0 && <span className="px-1.5 text-muted-foreground/50">·</span>}
                  <span className="text-muted-foreground/70">{pair.label}</span> {pair.value}
                </span>
              ))}
            </span>
            <ChevronDown
              aria-hidden
              className={cn(
                "mt-0.5 size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </button>
          {open && (
            <div
              id={detailId}
              className="mb-1 flex flex-col gap-3 rounded-lg border border-border/70 p-3 text-[13px]"
            >
              <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[max-content_minmax(0,1fr)]">
                <Fact label="When" value={fmtDateTimePrecise(row.ts)} />
                <Fact label="Record" value={`#${row.id}`} />
              </dl>
              {full && (
                <pre
                  tabIndex={0}
                  aria-label={`Raw record for ${action}`}
                  className="max-h-56 overflow-auto rounded-md border border-border/60 p-2 font-sans text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {full}
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words [overflow-wrap:anywhere]">{value}</dd>
    </>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  );
}
