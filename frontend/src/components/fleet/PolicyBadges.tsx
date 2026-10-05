import { Globe } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FleetRow } from "@/components/overview/types";

const EXPLANATION = "Configuration only. Scheduled internet blocking and current device enforcement are unknown.";

/** Configured internet block (never observed enforcement). App-rule counts are deliberately not shown. */
export function PolicyBadges({ row }: { row: FleetRow }) {
  const unknown = row.internetBlocked == null || row.appBlockEnabledCount == null;
  if (unknown) {
    if (row.enrichmentStatus === "missing" || row.enrichmentStatus === "error") {
      return (
        <span className="text-xs text-muted-foreground">
          {row.enrichmentStatus === "missing" ? "Device absent from fleet summary" : "Policy configuration unavailable"}
        </span>
      );
    }
    return null;
  }
  if (!row.internetBlocked) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-xs text-destructive" />}>
        <Globe className="size-3.5" /> Internet block
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{EXPLANATION}</TooltipContent>
    </Tooltip>
  );
}
