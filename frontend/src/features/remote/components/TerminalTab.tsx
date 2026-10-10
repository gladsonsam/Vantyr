import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Info, RefreshCw, TriangleAlert } from "lucide-react";
import { Alert, AlertTitle } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { buildWsUrl } from "@/api/serverSettings";
import type { AgentInfo, DashboardRole } from "@/api/types";
import { capabilityAvailable } from "@/features/agent-detail/lib/agentCapabilities";
import { CapabilityNotice } from "@/features/agent-detail/components/CapabilityNotice";
import { cn } from "@/lib/utils";
import { useRemoteEnvironment } from "@/features/remote/hooks/useRemoteEnvironment";

interface Props {
  agentId: string;
  agentOnline?: boolean;
  agentInfo?: AgentInfo | null;
  dashboardRole?: DashboardRole | null;
}

// Consolas first: it's a real monospace always present on Windows, so xterm can
// measure the cell width correctly even before the webfont loads. IBM Plex Mono
// (the app font) is preloaded below and used once available.
const TERM_FONT = "'IBM Plex Mono', Consolas, 'Cascadia Mono', 'Courier New', monospace";
const TERM_FONT_SIZE = 13;

type Connection = "connecting" | "live" | "ended" | "refused" | "dropped";

const CONNECTION_NOTICE: Partial<Record<Connection, string>> = {
  refused: "The terminal was refused — the agent needs updating or this module authorised on the device.",
  dropped: "The connection to the terminal was lost.",
  ended: "The terminal session ended.",
};

/**
 * Interactive remote terminal (xterm.js ↔ /ws/terminal ↔ agent ConPTY).
 * Server-gated: operator role + ALLOW_REMOTE_SCRIPT_EXECUTION. Not available when the
 * remote environment says so (the demo build has no live agent).
 */
export function TerminalTab({ agentId, agentOnline = true, agentInfo, dashboardRole = null }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalAvailable = capabilityAvailable(agentInfo, "terminal");
  const blockedByRole = dashboardRole === "viewer";
  const { terminalUnavailable } = useRemoteEnvironment();
  const [connection, setConnection] = useState<Connection>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (terminalUnavailable || agentOnline === false || !terminalAvailable || blockedByRole) return;
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    setConnection("connecting");
    let cleanup: (() => void) | null = null;

    const init = async () => {
      // Make sure the monospace font is loaded BEFORE xterm measures the cell
      // size, otherwise it sizes cells for a fallback font and glyphs render
      // with gaps inside words.
      try {
        await document.fonts.load(`${TERM_FONT_SIZE}px "IBM Plex Mono"`);
        await document.fonts.ready;
      } catch {
        /* fonts API unavailable — fall back to Consolas/monospace */
      }
      if (disposed || !containerRef.current) return;

      const term = new XTerm({
        cursorBlink: true,
        fontFamily: TERM_FONT,
        fontSize: TERM_FONT_SIZE,
        lineHeight: 1.15,
        letterSpacing: 0,
        scrollback: 5000,
        theme: { background: "#0c0d10", foreground: "#e6e6e6", cursor: "#20dd8f" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
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
        opened = true;
        term.focus();
        setConnection("live");
        term.writeln("\x1b[2mConnected. Starting shell…\x1b[0m");
      };
      ws.onmessage = (ev) => {
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
        if (disposed) return;
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
      const onWinResize = () => safeFit();
      window.addEventListener("resize", onWinResize);

      cleanup = () => {
        window.removeEventListener("resize", onWinResize);
        dataDisp.dispose();
        resizeDisp.dispose();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        term.dispose();
      };
    };

    void init();

    return () => {
      disposed = true;
      if (cleanup) cleanup();
    };
  }, [agentId, agentOnline, terminalAvailable, blockedByRole, terminalUnavailable, attempt]);

  const notice = CONNECTION_NOTICE[connection];

  if (blockedByRole) {
    return (
      <Alert>
        <Info />
        <AlertTitle>Operators only.</AlertTitle>
      </Alert>
    );
  }

  if (terminalUnavailable) {
    return (
      <div className="rounded-xl bg-card p-6 text-sm text-muted-foreground">
        {terminalUnavailable}
      </div>
    );
  }
  if (agentOnline === false) {
    return (
      <div className="rounded-xl bg-card p-6 text-sm text-muted-foreground">
        Agent offline.
      </div>
    );
  }
  if (!terminalAvailable) {
    return <CapabilityNotice info={agentInfo} capability="terminal" title="Terminal unavailable" />;
  }

  return (
    <div className="relative rounded-xl bg-card p-2">
      <div
        ref={containerRef}
        className="h-[460px] w-full overflow-hidden rounded-lg"
        style={{ background: "#0c0d10" }}
      />
      {notice && (
        <div
          className={cn(
            "flex items-center justify-between gap-4 px-3 pt-3 pb-1 text-sm",
            connection === "ended" ? "text-muted-foreground" : "text-warning",
          )}
          role="status"
        >
          <span className="flex items-center gap-2">
            {connection !== "ended" && <TriangleAlert className="size-4 shrink-0" />}
            {notice}
          </span>
          <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw /> {connection === "refused" ? "Retry" : "Reconnect"}
          </Button>
        </div>
      )}
    </div>
  );
}
