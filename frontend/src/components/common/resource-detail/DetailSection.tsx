import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A titled block on a detail page, separated from the one above by a hairline. */
export function DetailSection({
  title,
  icon: Icon,
  action,
  className,
  children,
}: {
  title: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-4 border-t pt-6 first:border-t-0 first:pt-0", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {Icon ? <Icon className="size-4" /> : null}
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
