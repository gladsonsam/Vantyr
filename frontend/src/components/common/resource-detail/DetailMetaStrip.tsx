import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface DetailMetaItem {
  icon?: ComponentType<{ className?: string }>;
  label?: string;
  value: ReactNode;
  mono?: boolean;
}

/** One muted row of the facts that identify a resource (image, uptime, address…). */
export function DetailMetaStrip({
  items = [],
  className,
  children,
}: {
  items?: DetailMetaItem[];
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-muted/40 px-4 py-3",
        className,
      )}
    >
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {item.icon ? <item.icon className="size-4 shrink-0" /> : null}
          {item.label ? <span className="text-xs font-medium">{item.label}</span> : null}
          <span className={cn(item.mono && "font-mono break-all select-all")}>{item.value}</span>
        </div>
      ))}
      {children}
    </div>
  );
}
