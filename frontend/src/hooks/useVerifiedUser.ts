import { useEffect, useState } from "react";
import { api } from "@/api";
import { buildApiUrl } from "@/api/serverSettings";
import { onSessionExpired } from "@/api/sessionExpiry";

/** Identity of the configured API server, used to scope browser-local state per server. */
export function fleetServerScope() {
  try { return new URL(buildApiUrl("/"), window.location.href).href; } catch { return ""; }
}
/**
 * Verified dashboard user for `server`, re-checked on focus. The last verified user stays in place while
 * re-checking so unchanged identities never reset scoped state; it is replaced on a different user and
 * cleared on server change or session expiry (any 401, via `onSessionExpired`).
 */
export function useVerifiedUser(server: string) {
  const [identity, setIdentity] = useState<{ server: string; user: string } | null>(null);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let pending: AbortController | null = null;
    const verify = () => {
      if (pending || !server || typeof api.me !== "function") return;
      const request = ++generation;
      const controller = new AbortController(); pending = controller;
      void api.me(controller.signal).then((user) => {
        if (!alive || request !== generation || fleetServerScope() !== server) return;
        const next = typeof user.id === "string" && user.id ? user.id : null;
        setIdentity((previous) => next === null ? null : previous?.server === server && previous.user === next ? previous : { server, user: next });
      }).catch(() => {}).finally(() => { if (pending === controller) pending = null; });
    };
    const expire = () => { ++generation; pending?.abort(); pending = null; setIdentity(null); };
    verify();
    window.addEventListener("focus", verify);
    const unsubscribeExpiry = onSessionExpired(expire);
    return () => { alive = false; ++generation; pending?.abort(); pending = null; window.removeEventListener("focus", verify); unsubscribeExpiry(); };
  }, [server]);
  return identity?.server === server ? identity.user : null;
}
