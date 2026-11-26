import { cn } from "@/lib/utils";
import type { ConnectionState } from "@/features/devices/lib/deviceModel";

const TONE: Record<ConnectionState, { text: string; label: string }> = {
  connected: { text: "text-success", label: "Connected" },
  stale: { text: "text-warning", label: "Not reporting" },
  none: { text: "text-muted-foreground", label: "Not connected" },
};

/** One connection's state as a dot and a word (no pill). */
export function ConnectionStatus({
  state,
  className,
}: {
  state: ConnectionState;
  className?: string;
}) {
  const tone = TONE[state];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-sm font-medium", tone.text, className)}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {tone.label}
    </span>
  );
}
