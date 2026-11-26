import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SortDirection = "asc" | "desc" | null;

/**
 * Arcane's sortable column header: a ghost button with an arrow that shows the current direction
 * (up, down, or the neutral up-down mark when the column is not the sort key).
 */
export function SortHeaderButton({
  title,
  direction,
  onClick,
  align = "left",
  className,
}: {
  title: string;
  direction: SortDirection;
  onClick: () => void;
  align?: "left" | "right";
  className?: string;
}) {
  const Arrow = direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Sort by ${title}`}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
        align === "left" ? "-ml-2.5" : "-mr-2.5",
        direction ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {title}
      <Arrow
        className={cn("size-3.5", direction ? "text-primary" : "text-muted-foreground/70")}
        aria-hidden="true"
      />
    </button>
  );
}
