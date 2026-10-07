import type { RemoteEnvironment } from "@/features/remote/hooks/useRemoteEnvironment";

/** The demo has no live agent: the terminal is unavailable and the clipboard is simulated. */
export const demoRemoteEnvironment: RemoteEnvironment = {
  terminalUnavailable: "Unavailable in demo mode.",
  clipboardNote: "Demo: clipboard is simulated.",
  clipboardSentMessage: "Sent to simulated clipboard.",
};

/** The recall screen's evidence is generated, and says so. */
export const demoRecallEvidenceNote = "Synthetic demo evidence. ";
