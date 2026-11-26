import { cn } from "@/lib/utils";

export type DotTone = "success" | "warning" | "destructive" | "muted";

const TONE: Record<DotTone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

/** A status as a dot and coloured text, never a chip. */
export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: DotTone;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", TONE[tone], className)}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}
