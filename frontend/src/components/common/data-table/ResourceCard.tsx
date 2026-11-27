import type { ComponentType, MouseEventHandler, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Arcane's resource card: an outlined card split by hairlines into a header (select, icon tile,
 * title, actions, context line), an optional meta list and a footer. Hover is a flat border change.
 */
export function ResourceCard({
  selected = false,
  onClick,
  select,
  icon,
  title,
  actions,
  context,
  fields,
  footer,
  children,
  className,
}: {
  selected?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  select?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  context?: ReactNode;
  fields?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="resource-card"
      data-state={selected ? "selected" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/10 text-sm transition-colors hover:border-foreground/25",
        onClick && "cursor-pointer",
        selected && "border-primary/60 hover:border-primary/60",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col divide-y divide-border/40 px-4">
        <header className="flex min-w-0 flex-col gap-2 py-3">
          <div className="flex min-w-0 items-start gap-3">
            {select ? (
              <div className="flex h-10 shrink-0 items-center" onClick={stop}>
                {select}
              </div>
            ) : null}
            {icon ? <div className="shrink-0">{icon}</div> : null}
            <div className="min-w-0 flex-1">{title}</div>
            {actions ? (
              <div className="-mr-2 flex shrink-0 items-center" onClick={stop}>
                {actions}
              </div>
            ) : null}
          </div>
          {context ? (
            <div className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
              {context}
            </div>
          ) : null}
        </header>
        {fields}
        {children}
        {footer ? (
          <footer
            className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2 text-xs text-muted-foreground tabular-nums"
            onClick={stop}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function stop(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

/** Labelled values in a two-column meta list (label over value), as on Arcane's cards. */
export function ResourceCardFields({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <dl className={cn("grid grid-cols-2 gap-x-4 gap-y-3 py-3", className)}>{children}</dl>;
}

export function ResourceCardField({
  label,
  icon: Icon,
  wide,
  title,
  children,
  className,
}: {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  /** Spans both columns. */
  wide?: boolean;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", wide && "col-span-2", className)}>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon ? <Icon className="size-3.5 shrink-0 opacity-70" /> : null}
        <span className="truncate">{label}</span>
      </dt>
      <dd title={title} className="min-w-0 truncate text-sm text-foreground/90">
        {children}
      </dd>
    </div>
  );
}
