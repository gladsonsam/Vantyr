import { CircleAlert, CircleX } from "lucide-react";
import { cn } from "@/lib/utils";

const OUTCOMES: Record<string, { label: string; Icon: typeof CircleX; className: string }> = {
  error: { label: "Failed", Icon: CircleX, className: "text-destructive" },
  rejected: { label: "Rejected", Icon: CircleAlert, className: "text-warning" },
};

/**
 * What came of the recorded action, as an icon and word in its hue (no pill). Success is the norm, so it
 * draws nothing but still reads "Succeeded" to a screen reader; any other word the server stores is shown as is.
 */
export function AuditStatusBadge({ status }: { status: string }) {
  const key = (status || "").toLowerCase();
  if (key === "ok") return <span className="sr-only">Succeeded</span>;
  const outcome = OUTCOMES[key];
  const Icon = outcome?.Icon ?? CircleAlert;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", outcome?.className ?? "text-muted-foreground")}>
      <Icon className="size-3.5" aria-hidden />
      {outcome?.label ?? status}
    </span>
  );
}
