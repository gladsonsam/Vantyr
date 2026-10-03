import { useCallback, useEffect, useRef, useState } from "react";

interface Grant { agentId: string; token: string; deadline: number }
interface Pending { agentId: string; id: string; kind: "acquire" | "heartbeat"; sentAt: number }
export function useRemoteControlLease(agentId: string, enabled: boolean, send: (message: unknown) => void) {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [acquiringAgent, setAcquiringAgent] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{agentId: string; error: string} | null>(null);
  const current = useRef<Grant | null>(null);
  const pending = useRef<Pending | null>(null);
  const cancelled = useRef(new Map<string, string>());
  const cancelPending = () => {
    if (pending.current) cancelled.current.set(pending.current.id, pending.current.agentId);
    pending.current = null;
    while (cancelled.current.size > 64) cancelled.current.delete(cancelled.current.keys().next().value!);
  };
  const sendRef = useRef(send); sendRef.current = send;
  const allowed = useRef(enabled); allowed.current = enabled;
  const scope = useRef(agentId); scope.current = agentId;
  const setError = useCallback((error: string, id = scope.current) => setFeedback({agentId: id, error}), []);
  const release = useCallback(() => {
    const previous = current.current;
    current.current = null; cancelPending();
    setGrant(null); setAcquiringAgent(null);
    if (previous) sendRef.current({ type: "control_release", agent_id: previous.agentId, lease_token: previous.token, request_id: crypto.randomUUID() });
  }, []);
  const acquire = useCallback(() => {
    if (!allowed.current || pending.current || current.current) return;
    const id = crypto.randomUUID();
    pending.current = { agentId: scope.current, id, kind: "acquire", sentAt: performance.now() };
    setAcquiringAgent(scope.current); setError("");
    sendRef.current({ type: "control_acquire", agent_id: scope.current, request_id: id });
  }, [setError]);
  useEffect(() => {
    const fail = (message: string) => setError(message, agentId);
    const onEvent = (event: Event) => {
      const message = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!message || message.event !== "control_lease") return;
      const cancelledAgent = cancelled.current.get(String(message.request_id));
      if (cancelledAgent && cancelledAgent === message.agent_id) {
        cancelled.current.delete(String(message.request_id));
        if (message.status === "granted" && typeof message.lease_token === "string") sendRef.current({ type: "control_release", agent_id: cancelledAgent, lease_token: message.lease_token, request_id: crypto.randomUUID() });
        return;
      }
      if (message.agent_id !== agentId) return;
      const request = pending.current;
      if (message.status === "revoked" && current.current && message.lease_token === current.current.token) {
        release(); fail(typeof message.error === "string" ? message.error : "Control ended. Take control again to continue."); return;
      }
      if (!request || message.request_id !== request.id) return;
      pending.current = null; setAcquiringAgent(null);
      const duration = message.expires_in_ms;
      if (message.status === "granted" && allowed.current && scope.current === agentId && typeof message.lease_token === "string" && typeof duration === "number" && Number.isFinite(duration) && duration > 0 && duration <= 30000) {
        if (request.kind === "heartbeat" && message.lease_token !== current.current?.token) { release(); fail("Control session changed. Take control again."); return; }
        // Count transit time against the local deadline; never extend from receipt alone.
        const next = { agentId, token: message.lease_token, deadline: request.sentAt + duration };
        if (next.deadline <= performance.now()) { sendRef.current({ type: "control_release", agent_id: agentId, lease_token: next.token, request_id: crypto.randomUUID() }); release(); fail("Control confirmation arrived too late. Try again."); return; }
        current.current = next; setGrant(next); fail("");
      } else {
        if (message.status === "granted" && typeof message.lease_token === "string" && message.lease_token !== current.current?.token) sendRef.current({ type: "control_release", agent_id: agentId, lease_token: message.lease_token, request_id: crypto.randomUUID() });
        release(); fail(typeof message.error === "string" ? message.error : "Control was not granted. Check device permissions and try again.");
      }
    };
    const onBlur = () => release();
    const onVisibility = () => { if (document.hidden) release(); };
    const onStatus = (event: Event) => { if ((event as CustomEvent<string>).detail !== "connected") release(); };
    window.addEventListener("vantyr-ws-event", onEvent);
    window.addEventListener("vantyr-ws-status", onStatus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      const now = performance.now(), active = current.current, request = pending.current;
      if (active && now >= active.deadline) { release(); fail("Control expired. Take control again."); return; }
      if (request && now - request.sentAt >= 5000) { release(); fail("Control confirmation timed out. Try again."); return; }
      if (active && !request && !document.hidden && active.deadline - now <= 10000) {
        const id = crypto.randomUUID(); pending.current = { agentId: active.agentId, id, kind: "heartbeat", sentAt: now };
        sendRef.current({ type: "control_heartbeat", agent_id: active.agentId, lease_token: active.token, request_id: id });
      }
    }, 500);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("vantyr-ws-event", onEvent); window.removeEventListener("vantyr-ws-status", onStatus);
      window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onVisibility);
      const previous = current.current; current.current = null; cancelPending();
      if (previous) sendRef.current({ type: "control_release", agent_id: previous.agentId, lease_token: previous.token, request_id: crypto.randomUUID() });
    };
  }, [agentId, release, setError]);
  useEffect(() => { if (!enabled) release(); }, [enabled, release]);
  const token = enabled && grant?.agentId === agentId && grant.deadline > performance.now() ? grant.token : null;
  return { token, acquiring: acquiringAgent === agentId, error: feedback?.agentId === agentId ? feedback.error : "", acquire, release };
}
