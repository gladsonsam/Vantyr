import { Badge } from "../ui/console";

/** Traffic-light styling for audit `status` (matches docker log levels: ok / warn / error). */
export function AuditStatusBadge({ status }: { status: string }) {
  const s = (status || "").toLowerCase();
  if (s === "ok") {
    return <Badge color="green">{status}</Badge>;
  }
  if (s === "error") {
    return <Badge color="red">{status}</Badge>;
  }
  if (s === "rejected") {
    return (
      <span className="sentinel-audit-status-warn" title="Rejected / rate limited">
        {status}
      </span>
    );
  }
  return <Badge color="grey">{status}</Badge>;
}
