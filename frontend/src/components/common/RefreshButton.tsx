import { RefreshCw } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { cn } from "@/lib/utils";

/** The one refresh control: an icon that spins while loading, instead of a "Refresh" text button per card. */
export function RefreshButton({ onClick, loading = false, label = "Refresh", className }: {
  onClick: () => void;
  loading?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("text-muted-foreground hover:text-foreground", className)}
      disabled={loading}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <RefreshCw className={cn(loading && "animate-spin")} />
    </Button>
  );
}
