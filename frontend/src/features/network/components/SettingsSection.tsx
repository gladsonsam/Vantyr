import type { ReactNode } from "react";
import { Card } from "@vantyr/ui/components/card";
import { cn } from "@/lib/utils";

/**
 * An outlined settings section: a title row (icon, title, description, optional trailing slot) over a
 * hairline, then the body. Rows inside it are separated by hairlines.
 */
export function SettingsSection({
  title,
  description,
  icon,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      <div className="flex items-center justify-between gap-4 border-b border-border/50 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon ? (
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4"
              aria-hidden="true"
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight">{title}</h3>
            {description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={cn("divide-y divide-border/50 px-5", bodyClassName)}>{children}</div>
    </Card>
  );
}
