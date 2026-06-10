import { useEffect, useMemo, useState } from "react";
import { Header, SpaceBetween, ButtonDropdown, StatusIndicator, Button } from "../ui/console";
import type { Agent, AgentLiveStatus } from "../../lib/types";
import { fmtDateTime } from "../../lib/utils";
import { ActivityStatus } from "../common/StatusIndicator";

export type AgentAction =
  | "restart-host"
  | "shutdown-host"
  | "lock-host"
  | "request-info"
  | "wake-lan";

type PageHeaderMenuAction =
  | AgentAction
  | "help"
  | "copy-agent-id"
  | "copy-agent-name"
  | "copy-hostname";

interface PageHeaderProps {
  agent: Agent;
  liveStatus?: AgentLiveStatus;
  infoHostname?: string | null;
  /** Epoch ms when the user clicked "Refresh info". */
  infoRequestedAtMs?: number | null;
  /** Last `agent_info.ts` (unix seconds) we’ve seen for this agent. */
  infoUpdatedTsSecs?: number | null;
  /**
   * If provided, show an "Idle / Away" indicator even when we haven't seen a live AFK WS event.
   * This is derived from stored telemetry (e.g. last activity_log row).
   */
  inferredIdleSeconds?: number | null;
  onOpenHelp: () => void;
  onRunAction: (action: AgentAction) => void;
  pendingAction?: AgentAction | null;
}

export function PageHeader({
  agent,
  liveStatus,
  infoHostname,
  infoRequestedAtMs,
  infoUpdatedTsSecs,
  inferredIdleSeconds,
  onOpenHelp,
  onRunAction,
  pendingAction = null,
}: PageHeaderProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Keep AFK/idle counters ticking on the agent detail page.
  useEffect(() => {
    const needsTick =
      (agent.online && liveStatus?.activity === "afk" && typeof liveStatus.idleSinceMs === "number") ||
      inferredIdleSeconds != null;
    if (!needsTick) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [agent.online, liveStatus?.activity, liveStatus?.idleSinceMs, inferredIdleSeconds]);

  const isAfk = agent.online && liveStatus?.activity === "afk";
  /** Live "active" from WS must win over a stale activity_log–based inference. */
  const liveSaysActive = agent.online && liveStatus?.activity === "active";
  const showInferredIdle =
    !isAfk &&
    !liveSaysActive &&
    inferredIdleSeconds != null &&
    inferredIdleSeconds >= 60;
  const effectiveAfkIdleSecs =
    isAfk && typeof liveStatus?.idleSinceMs === "number"
      ? Math.max(0, Math.floor((nowMs - liveStatus.idleSinceMs) / 1000))
      : liveStatus?.idleSecs;

  const idleLine = isAfk ? (
    <ActivityStatus isAfk idleSeconds={effectiveAfkIdleSecs} />
  ) : showInferredIdle ? (
    <StatusIndicator type="warning">
      Idle / Away ({Math.floor((inferredIdleSeconds as number) / 60)}m)
    </StatusIndicator>
  ) : null;

  const connectedText = `Connected: ${agent.connected_at ? fmtDateTime(agent.connected_at) : "offline"}`;

  const canLock = agent.online;
  const canRestart = agent.online;
  const canShutdown = agent.online;
  const canRequestInfo = agent.online;

  const showRequested =
    infoRequestedAtMs != null && nowMs - infoRequestedAtMs < 15_000;

  const infoUpdatedLine = useMemo(() => {
    if (!infoUpdatedTsSecs) return null;
    const updatedMs = infoUpdatedTsSecs * 1000;
    const ageSec = Math.max(0, Math.floor((nowMs - updatedMs) / 1000));
    if (ageSec < 10) return "Updated just now";
    if (ageSec < 60) return `Updated ${ageSec}s ago`;
    const m = Math.floor(ageSec / 60);
    return `Updated ${m}m ago`;
  }, [infoUpdatedTsSecs, nowMs]);

  const actionItems: any[] = useMemo(() => {
    const canCopy = typeof navigator !== "undefined" && Boolean(navigator.clipboard?.writeText);
    const copyItems: any[] = [
      ...(canCopy ? ([{ id: "copy-agent-id", text: "Copy agent ID" }] as const) : []),
      ...(canCopy ? ([{ id: "copy-agent-name", text: "Copy agent name" }] as const) : []),
      ...(canCopy && infoHostname ? ([{ id: "copy-hostname", text: "Copy hostname" }] as const) : []),
    ];

    const powerItems: any[] = [
      ...(!agent.online ? [{ id: "wake-lan", text: "Wake on LAN" } as const] : []),
      ...(canLock ? [{ id: "lock-host", text: "Lock computer" } as const] : []),
    ];

    const dangerItems: any[] = [
      ...(canRestart ? [{ id: "restart-host", text: "Restart computer" } as const] : []),
      ...(canShutdown ? [{ id: "shutdown-host", text: "Shutdown computer" } as const] : []),
    ];

    const out: any[] = [];
    if (copyItems.length) out.push({ text: "Copy", items: copyItems });
    if (powerItems.length) out.push({ text: "Actions", items: powerItems });
    if (dangerItems.length) out.push({ text: "Danger zone", items: dangerItems });
    out.push({ id: "help", text: "Open help" });
    return out;
  }, [agent.online, canLock, canRestart, canShutdown, infoHostname]);

  return (
    <Header
      variant="h1"
      description={
        <SpaceBetween size="xs">
          {idleLine}
          <div>{connectedText}</div>
          {showRequested ? (
            <StatusIndicator type="in-progress">Requested fresh info…</StatusIndicator>
          ) : infoUpdatedLine ? (
            <StatusIndicator type="success">{infoUpdatedLine}</StatusIndicator>
          ) : null}
        </SpaceBetween>
      }
      actions={
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <Button
            iconName="refresh"
            disabled={!canRequestInfo || pendingAction === "request-info"}
            loading={pendingAction === "request-info"}
            onClick={() => onRunAction("request-info")}
          >
            Refresh info
          </Button>

          <ButtonDropdown
            items={actionItems}
            onItemClick={(e) => {
              const id = String(e.detail.id) as PageHeaderMenuAction;
              if (id === "help") {
                onOpenHelp();
                return;
              }

              if (id === "copy-agent-id") {
                void navigator.clipboard?.writeText(agent.id).catch(() => {});
                return;
              }
              if (id === "copy-agent-name") {
                void navigator.clipboard?.writeText(agent.name).catch(() => {});
                return;
              }
              if (id === "copy-hostname") {
                void navigator.clipboard?.writeText(String(infoHostname ?? "")).catch(() => {});
                return;
              }

              onRunAction(id);
            }}
            variant="normal"
          />
        </SpaceBetween>
      }
    >
      {agent.name}
    </Header>
  );
}
