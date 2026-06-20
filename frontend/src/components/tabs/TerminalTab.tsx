import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { buildWsUrl } from "../../lib/serverSettings";
import { isDemoMode } from "../../demo/mode";
import type { AgentInfo } from "../../lib/types";
import { capabilityAvailable } from "../../lib/agentCapabilities";
import { CapabilityNotice } from "../common/CapabilityNotice";

interface Props {
  agentId: string;
  agentOnline?: boolean;
  agentInfo?: AgentInfo | null;
}

// Consolas first: it's a real monospace always present on Windows, so xterm can
// measure the cell width correctly even before the webfont loads. IBM Plex Mono
// (the app font) is preloaded below and used once available.
const TERM_FONT = "'IBM Plex Mono', Consolas, 'Cascadia Mono', 'Courier New', monospace";
const TERM_FONT_SIZE = 13;

/**
 * Interactive remote terminal (xterm.js ↔ /ws/terminal ↔ agent ConPTY).
 * Server-gated: operator role + ALLOW_REMOTE_SCRIPT_EXECUTION. Not available in
 * demo mode (needs a live agent).
 */
export function TerminalTab({ agentId, agentOnline = true, agentInfo }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalAvailable = capabilityAvailable(agentInfo, "terminal");

  useEffect(() => {
    if (isDemoMode || agentOnline === false || !terminalAvailable) return;
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
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
      term.focus();

      const url =
        buildWsUrl("/ws/terminal") +
        `?agent_id=${encodeURIComponent(agentId)}&cols=${term.cols}&rows=${term.rows}`;
      const ws = new WebSocket(url);

      ws.onopen = () => term.writeln("\x1b[2mConnected. Starting shell…\x1b[0m");
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "terminal_output" && typeof msg.data_b64 === "string") {
            const bin = atob(msg.data_b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            term.write(bytes);
          } else if (msg.type === "terminal_exit") {
            term.writeln("\r\n\x1b[2m[shell exited]\x1b[0m");
          } else if (msg.type === "terminal_error") {
            term.writeln(`\r\n\x1b[31m${msg.message ?? "terminal error"}\x1b[0m`);
          }
        } catch {
          /* ignore non-JSON frames */
        }
      };
      ws.onclose = () => {
        if (!disposed) term.writeln("\r\n\x1b[2m[disconnected]\x1b[0m");
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
  }, [agentId, agentOnline, terminalAvailable]);

  if (isDemoMode) {
    return (
      <div style={{ padding: 24, color: "var(--tx-2, #9aa0aa)" }}>
        The interactive terminal needs a live agent connection and is not available in demo mode.
      </div>
    );
  }
  if (agentOnline === false) {
    return (
      <div style={{ padding: 24, color: "var(--tx-2, #9aa0aa)" }}>
        Agent is offline. The terminal becomes available when the agent reconnects.
      </div>
    );
  }
  if (!terminalAvailable) {
    return <CapabilityNotice info={agentInfo} capability="terminal" title="Terminal unavailable" />;
  }

  return (
    <div
      style={{
        background: "#0c0d10",
        borderRadius: 8,
        border: "1px solid var(--line, #2a2c30)",
        padding: 8,
        height: 460,
      }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
