export type TerminalConnection = "connecting" | "live" | "ended" | "refused" | "dropped";
export type TerminalPhase = "idle" | TerminalConnection;

export interface TerminalStatus {
  text: string;
  tone: "muted" | "ok" | "warn";
  /** The one button beside the status; null while idle (the frame offers the start button). */
  action: { label: string; kind: "stop" | "start" } | null;
}

/**
 * What the terminal tells the person above it. A new shell only ever starts from a button the
 * person presses ("Start", "Reconnect", "New session"): nothing here reconnects by itself.
 */
export function terminalStatus(phase: TerminalPhase): TerminalStatus {
  switch (phase) {
    case "idle":
      return { text: "Not started", tone: "muted", action: null };
    case "connecting":
      return { text: "Connecting…", tone: "muted", action: { label: "Cancel", kind: "stop" } };
    case "live":
      return { text: "Connected", tone: "ok", action: { label: "End session", kind: "stop" } };
    case "ended":
      return {
        text: "Session ended",
        tone: "muted",
        action: { label: "New session", kind: "start" },
      };
    case "dropped":
      return {
        text: "Connection lost",
        tone: "warn",
        action: { label: "Reconnect", kind: "start" },
      };
    case "refused":
      return {
        text: "Refused. The agent may need updating, or terminal access must be allowed on the device.",
        tone: "warn",
        action: { label: "Retry", kind: "start" },
      };
  }
}
