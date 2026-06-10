import { StatusIndicator } from "../ui/console";

interface ConnectionStatusProps {
  connected: boolean;
  lastSeen?: Date | null;
}

export function ConnectionStatus({ connected, lastSeen }: ConnectionStatusProps) {
  if (connected) {
    return <StatusIndicator type="success">Connected</StatusIndicator>;
  }

  const getOfflineText = () => {
    if (!lastSeen) return "Disconnected";
    const now = Date.now();
    const lastSeenMs = lastSeen.getTime();
    const diffMs = now - lastSeenMs;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffDay > 0) return `Disconnected (${diffDay}d ago)`;
    if (diffHour > 0) return `Disconnected (${diffHour}h ago)`;
    if (diffMin > 0) return `Disconnected (${diffMin}m ago)`;
    return `Disconnected (${diffSec}s ago)`;
  };

  return <StatusIndicator type="stopped">{getOfflineText()}</StatusIndicator>;
}

interface ActivityStatusProps {
  isAfk: boolean;
  idleSeconds?: number;
}

export function ActivityStatus({ isAfk, idleSeconds }: ActivityStatusProps) {
  if (isAfk) {
    const idleText =
      idleSeconds == null
        ? ""
        : idleSeconds < 60
          ? ` (${idleSeconds}s idle)`
          : ` (${Math.floor(idleSeconds / 60)}m idle)`;
    return (
      <StatusIndicator type="warning">
        AFK{idleText}
      </StatusIndicator>
    );
  }

  return <StatusIndicator type="success">Active</StatusIndicator>;
}

interface StreamStatusProps {
  state: "streaming" | "starting" | "waiting" | "stalled" | "blocked";
}

export function StreamStatus({ state }: StreamStatusProps) {
  if (state === "streaming") {
    // Use success (calm) — not `in-progress`, which reads as warning/loading next to the Remote control toggle.
    return (
      <StatusIndicator type="success">
        <span className="sentinel-pulse">Streaming</span>
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

interface GenericStatusProps {
  type: string;
  children: React.ReactNode;
}

export function GenericStatus({ type, children }: GenericStatusProps) {
  return <StatusIndicator type={type}>{children}</StatusIndicator>;
}
