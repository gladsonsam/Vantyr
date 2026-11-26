import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A small outlined cell: muted label over a value. Lay several out in a grid. */
export function KeyValueCard({
  label,
  children,
  format = "code",
  stacked = false,
  title,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  /** `code` for ids and addresses, `text` for prose, `custom` keeps the value's own formatting. */
  format?: "code" | "text" | "custom";
  stacked?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card/10 p-4",
        className,
      )}
    >
      <div className="text-xs break-all text-muted-foreground">{label}</div>
      <div
        title={title}
        className={cn(
          format === "text" && "text-sm font-medium text-foreground",
          format === "code" && "font-mono text-sm break-all text-foreground select-all",
          stacked && "flex flex-col gap-2",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** The grid Arcane lays these cells in. */
export function KeyValueGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
