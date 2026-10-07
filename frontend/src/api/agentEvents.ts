/** Client-side broadcast after agents are deleted, so live stores can drop them. */
export const AGENT_REMOVED_EVENT = "vantyr-agent-removed";

export function notifyAgentRemoved(agentId: string) {
  window.dispatchEvent(new CustomEvent(AGENT_REMOVED_EVENT, { detail: agentId }));
}
