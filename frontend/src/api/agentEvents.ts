type AgentRemovedListener = (agentId: string) => void;

const listeners = new Set<AgentRemovedListener>();

/**
 * Subscribe to client-side agent deletions (after a successful delete call), so live stores can
 * drop the agent. Returns the unsubscribe function.
 */
export function onAgentRemoved(listener: AgentRemovedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyAgentRemoved(agentId: string): void {
  for (const listener of [...listeners]) listener(agentId);
}
