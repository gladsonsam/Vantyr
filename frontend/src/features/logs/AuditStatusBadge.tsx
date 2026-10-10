import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, { text: string; title: string }> = {
  ok: { text: "text-success", title: "Stored snapshot: check passed" },
  error: { text: "text-destructive", title: "Stored snapshot: check failed" },
  rejected: { text: "text-warning", title: "Rejected / rate limited" },
};

/** Audit `status` as plain text in its hue — no pill. Titles keep the stored-snapshot wording: freshness is unknown. */
export function AuditStatusBadge({ status }: { status: string }) {
  const key = (status || "").toLowerCase();
  const tone = STATUS_TONE[key] ?? { text: "text-muted-foreground", title: "Stored snapshot — freshness is unknown" };
  return (
    <span className={cn("text-xs font-medium", tone.text)} title={tone.title}>
      {status}
    </span>
  );
}
