import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** An outlined card with a title row (title, optional help, optional action) for the device Overview. */
export function OverviewCard({
  title,
  help,
  action,
  className,
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-5 rounded-xl border border-border/70 bg-card/10 p-6",
        className,
      )}
    >
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          {title}
          {help}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
