import { fmtDateTime, fmtFromNow } from "@/lib/utils";

/** "5m ago" with the exact time on hover, or an em dash when there is no timestamp. */
export function TimeAgo({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={iso} title={fmtDateTime(iso)}>
      {fmtFromNow(date)}
    </time>
  );
}
