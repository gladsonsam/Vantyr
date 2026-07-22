import { StatusIndicator } from "../ui/console";

interface StreamStatusProps {
  state: "streaming" | "starting" | "waiting" | "stalled" | "blocked";
}

export function StreamStatus({ state }: StreamStatusProps) {
  if (state === "streaming") {
    // Use success (calm) — not `in-progress`, which reads as warning/loading next to the Remote control toggle.
    return (
      <StatusIndicator type="success">
        <span className="vantyr-pulse">Streaming</span>
      </StatusIndicator>
    );
  }

  if (state === "starting") {
    return <StatusIndicator type="in-progress">Starting…</StatusIndicator>;
  }
  if (state === "waiting") {
    return <StatusIndicator type="pending">Waiting for frames…</StatusIndicator>;
  }
  if (state === "stalled") {
    return <StatusIndicator type="warning">Stalled</StatusIndicator>;
  }
  if (state === "blocked") {
    return <StatusIndicator type="stopped">Blocked</StatusIndicator>;
  }
  return <StatusIndicator type="stopped">Not streaming</StatusIndicator>;
}
