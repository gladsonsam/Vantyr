import type { ComponentType, ReactNode } from "react";
import { cn } from "@vantyr/ui/lib/utils";

type StatStripProps = {
  children: ReactNode;
  className?: string;
};

/** Compact inline row of stats (icon, number, label). */
export function StatStrip({ children, className }: StatStripProps) {
  return <div className={cn("flex flex-wrap items-center gap-x-1 gap-y-1", className)}>{children}</div>;
}

type StatStripItemProps = {
  icon?: ComponentType<{ className?: string }>;
  value: ReactNode;
  label: string;
  /** Makes the item a toggle button. */
  onClick?: () => void;
  active?: boolean;
  /** Tint for the icon, e.g. "text-warning". */
  tone?: string;
  className?: string;
};

export function StatStripItem({
  icon: Icon,
  value,
  label,
  onClick,
  active = false,
  tone,
  className,
}: StatStripItemProps) {
  const body = (
    <>
      {Icon ? <Icon className={cn("size-3.5 shrink-0", tone)} /> : null}
      <span className="font-medium text-foreground tabular-nums">{value}</span>
      <span>{label}</span>
    </>
  );
  const base =
    "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors";
  if (!onClick) return <span className={cn(base, className)}>{body}</span>;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        base,
        "outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary [&>span:nth-child(2)]:text-primary",
        className,
      )}
    >
      {body}
    </button>
  );
}
