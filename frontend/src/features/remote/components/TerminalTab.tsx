import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Info, RefreshCw, SquareTerminal, TriangleAlert } from "lucide-react";
import { Alert, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { buildWsUrl } from "@/api/serverSettings";
import type { AgentInfo, DashboardRole } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";
import { cn } from "@/lib/utils";
import { useRemoteEnvironment } from "@/features/remote/hooks/useRemoteEnvironment";
import {
  terminalStatus,
  type TerminalConnection,
  type TerminalPhase,
  type TerminalStatus,
} from "@/features/remote/lib/terminalStatus";

interface Props {
  agentId: string;
  agentOnline?: boolean;
  agentInfo?: AgentInfo | null;
  dashboardRole?: DashboardRole | null;
}

// Use the same bundled UI face as the rest of the application.
const TERM_FONT = '"Geist Variable", ui-sans-serif, system-ui, sans-serif';
const TERM_FONT_SIZE = 13;

type Connection = TerminalConnection;
const TERM_BG = "#0c0d10";

/**
 * Interactive remote terminal (xterm.js ↔ /ws/terminal ↔ agent ConPTY).
 * Server-gated: operator role + ALLOW_REMOTE_SCRIPT_EXECUTION. Not available when the
 * remote environment says so (the demo build has no live agent).
 */
export function TerminalTab({
  agentId,
  agentOnline = true,
  agentInfo,
  dashboardRole = null,
}: Props) {
  const terminalAvailable = capabilityAvailable(agentInfo, "terminal");
  const blockedByRole = dashboardRole === "viewer";
  const { terminalUnavailable } = useRemoteEnvironment();
  if (blockedByRole) {
    return (
      <Alert>
        <Info />
        <AlertTitle>Operators only.</AlertTitle>
      </Alert>
    );
  }

  if (terminalUnavailable) return <Unavailable>{terminalUnavailable}</Unavailable>;
  if (agentOnline === false)
    return <Unavailable>The device is offline. The terminal needs it online.</Unavailable>;
  if (!terminalAvailable) {
    return <CapabilityNotice info={agentInfo} capability="terminal" title="Terminal unavailable" />;
  }

  // Losing availability unmounts the session; returning never starts a new shell.
  return <TerminalSession key={agentId} agentId={agentId} />;
}

function TerminalSession({ agentId }: { agentId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [attempt, setAttempt] = useState(0);

  // attempt 0 = not started: opening the tab must not start a shell on the device by itself.
  useEffect(() => {
    if (attempt === 0) return;
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    setConnection("connecting");
    let cleanup: (() => void) | null = null;

    void startTerminalConnection(el, agentId, setConnection, () => !disposed)
      .then((nextCleanup) => {
        if (disposed) nextCleanup?.();
        else cleanup = nextCleanup ?? null;
      })
      .catch(() => {
        if (!disposed) setConnection("refused");
      });

    return () => {
      disposed = true;
      if (cleanup) cleanup();
    };
  }, [agentId, attempt]);

  const phase: TerminalPhase = attempt === 0 ? "idle" : connection;
  const status = terminalStatus(phase);

  return (
    <div className="flex flex-col gap-2">
      <TerminalStatusBar
        status={status}
        connecting={phase === "connecting"}
        onStart={() => setAttempt((n) => n + 1)}
        onStop={() => setAttempt(0)}
      />
      <div
        className="h-[clamp(16rem,calc(100dvh-18rem),42rem)] overflow-hidden rounded-xl p-2"
        style={{ background: TERM_BG }}
      >
        {attempt === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <SquareTerminal className="size-6 text-white/50" aria-hidden="true" />
            <p className="max-w-xs text-sm text-white/70">
              Opens a shell on this device. It closes when you leave this tab.
            </p>
            <Button onClick={() => setAttempt(1)}>Start terminal</Button>
          </div>
        ) : (
          <div
            ref={containerRef}
            aria-label="Remote terminal"
            role="group"
            className="h-full w-full overflow-hidden"
          />
        )}
      </div>
    </div>
  );
}

function Unavailable({ children }: { children: string }) {
  return <div className="rounded-xl border border-border/70 bg-card/10 p-6 text-sm text-muted-foreground">{children}</div>;
}

/** Connection state on the left, the one thing you can do about it on the right. */
function TerminalStatusBar({
  status,
  connecting,
  onStart,
  onStop,
}: {
  status: TerminalStatus;
  connecting: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const { action } = status;
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
      <p
        role="status"
        className={cn(
          "flex min-w-0 flex-1 items-start gap-2 text-sm",
          status.tone === "warn"
            ? "text-warning"
            : status.tone === "ok"
              ? "text-success"
              : "text-muted-foreground",
        )}
      >
        {connecting ? (
          <Spinner className="mt-0.5 shrink-0" />
        ) : status.tone === "warn" ? (
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        ) : (
          <span
            className={cn(
              "mt-[7px] size-[7px] shrink-0 rounded-full",
              status.tone === "ok" ? "bg-success" : "bg-muted-foreground/50",
            )}
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 break-words">{status.text}</span>
      </p>
      {action && (
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-9"
          onClick={action.kind === "start" ? onStart : onStop}
        >
          {action.kind === "start" && <RefreshCw />} {action.label}
        </Button>
      )}
    </div>
  );
}

async function startTerminalConnection(
  element: HTMLDivElement,
  agentId: string,
  setConnection: (connection: Connection) => void,
  isCurrent: () => boolean,
): Promise<(() => void) | undefined> {
  // Load the UI face before the terminal measures its character grid.
  try {
    await document.fonts.load(`${TERM_FONT_SIZE}px "Geist Variable"`);
    await document.fonts.ready;
  } catch {
    /* Fonts API unavailable; use the sans-serif fallback. */
  }
  if (!isCurrent()) return;

  const term = new XTerm({
    cursorBlink: true,
    fontFamily: TERM_FONT,
    fontSize: TERM_FONT_SIZE,
    lineHeight: 1.15,
    letterSpacing: 0,
    scrollback: 5000,
    theme: { background: TERM_BG, foreground: "#e6e6e6", cursor: "#20dd8f" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(element);
  const safeFit = () => {
    try {
      fit.fit();
    } catch {
      /* container not laid out yet */
    }
  };
  safeFit();

  const url =
    buildWsUrl("/ws/terminal") +
    `?agent_id=${encodeURIComponent(agentId)}&cols=${term.cols}&rows=${term.rows}`;
  const ws = new WebSocket(url);

  let opened = false;
  let exited = false;
  ws.onopen = () => {
    if (!isCurrent()) return;
    opened = true;
    term.focus();
    setConnection("live");
    term.writeln("\x1b[2mConnected. Starting shell…\x1b[0m");
  };
  ws.onmessage = (ev) => {
    if (!isCurrent()) return;
    try {
      const msg = JSON.parse(ev.data as string);
      if (msg.type === "terminal_output" && typeof msg.data_b64 === "string") {
        const bin = atob(msg.data_b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        term.write(bytes);
      } else if (msg.type === "terminal_exit") {
        exited = true;
        term.writeln("\r\n\x1b[2m[shell exited]\x1b[0m");
      } else if (msg.type === "terminal_error") {
        term.writeln(`\r\n\x1b[31m${msg.message ?? "terminal error"}\x1b[0m`);
      }
    } catch {
      /* ignore non-JSON frames */
    }
  };
  ws.onclose = () => {
    if (!isCurrent()) return;
    // Browsers hide the handshake status: closing before ever opening means the server refused the upgrade (e.g. 403).
    setConnection(!opened ? "refused" : exited ? "ended" : "dropped");
    if (opened) term.writeln("\r\n\x1b[2m[disconnected]\x1b[0m");
  };

  const dataDisp = term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
  });
  const resizeDisp = term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });
  // The frame follows the viewport height, so refit whenever its own size changes.
  const resizeWatcher = new ResizeObserver(safeFit);
  resizeWatcher.observe(element);

  return () => {
    resizeWatcher.disconnect();
    dataDisp.dispose();
    resizeDisp.dispose();
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    term.dispose();
  };
}
