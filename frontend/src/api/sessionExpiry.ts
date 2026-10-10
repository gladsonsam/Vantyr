type SessionExpiredListener = () => void;

const listeners = new Set<SessionExpiredListener>();

/**
 * Subscribe to session expiry: the fetch layer reports any 401 (outside `/login`) here, so the
 * session provider can demote to signed-out and live views can drop privileged state.
 * Returns the unsubscribe function.
 */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell every subscriber the server no longer accepts this session. */
export function notifySessionExpired(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      // One failing subscriber must not stop the others from tearing down.
      console.error("Session-expired listener failed:", err);
    }
  }
}
