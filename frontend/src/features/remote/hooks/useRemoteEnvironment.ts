import { createContext, useContext } from "react";

/**
 * What the remote tools can say about where they run. The defaults describe a real deployment;
 * the app root swaps in other values (the demo build's simulated terminal and clipboard).
 */
export interface RemoteEnvironment {
  /** Message shown instead of the terminal when it can't run here; null when it can. */
  terminalUnavailable: string | null;
  /** Extra line under the clipboard panel's intro; null for none. */
  clipboardNote: string | null;
  /** Confirmation once a clipboard write has been sent. */
  clipboardSentMessage: string;
}

export const realRemoteEnvironment: RemoteEnvironment = {
  terminalUnavailable: null,
  clipboardNote: null,
  clipboardSentMessage: "Sent to device clipboard.",
};

export const RemoteEnvironmentContext = createContext<RemoteEnvironment>(realRemoteEnvironment);

export function useRemoteEnvironment(): RemoteEnvironment {
  return useContext(RemoteEnvironmentContext);
}
