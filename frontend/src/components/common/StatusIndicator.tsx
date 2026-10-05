import { cn } from "@/lib/utils";

interface StreamStatusProps {
  state: "streaming" | "starting" | "waiting" | "stalled" | "blocked";
}

const STATE_TONE: Record<StreamStatusProps["state"], { text: string; label: string }> = {
  streaming: { text: "text-success", label: "Streaming" },
  starting: { text: "text-info", label: "Starting…" },
  waiting: { text: "text-warning", label: "Waiting for frames…" },
  stalled: { text: "text-warning", label: "Stalled" },
  blocked: { text: "text-destructive", label: "Blocked" },
};

/** Stream state as plain icon+text in its hue — no pill. */
export function StreamStatus({ state }: StreamStatusProps) {
  const tone = STATE_TONE[state] ?? { text: "text-muted-foreground", label: "Not streaming" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", tone.text)}>
      <span className="relative flex size-1.5">
        <span className={cn("absolute inline-flex size-full rounded-full opacity-60", state === "streaming" ? "animate-ping bg-success" : "bg-current")} />
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
      {tone.label}
    </span>
  );
}
