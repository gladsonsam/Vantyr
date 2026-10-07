import { useCallback, useEffect, useRef, useState } from "react";

export interface CaptureStamp { capture_id: string; geometry_revision: number }
interface CaptureScope { agentId: string; captureSession: string; captureIdentity: string | null }
interface Grant extends CaptureScope { token: string; deadline: number }
interface Pending extends CaptureScope { id: string; kind: "acquire" | "heartbeat"; sentAt: number }
export function useRemoteControlLease(agentId: string, enabled: boolean, send: (message: unknown) => void, options: { captureSession: string | null; getCaptureStamp?: () => CaptureStamp | null }) {
  const captureSession = options.captureSession;
  const stampGetter = useRef(options.getCaptureStamp); stampGetter.current = options.getCaptureStamp;
  const renderedStamp = options.getCaptureStamp?.();
  const captureIdentity = renderedStamp ? `${renderedStamp.capture_id}:${renderedStamp.geometry_revision}` : null;
  const identity = useRef(captureIdentity); identity.current = captureIdentity;
  const capture = useRef(captureSession); capture.current = captureSession;
  const [grant, setGrant] = useState<Grant | null>(null);
  const [acquiringScope, setAcquiringScope] = useState<CaptureScope | null>(null);
  const [feedback, setFeedback] = useState<{agentId: string; captureSession: string | null; captureIdentity: string | null; error: string} | null>(null);
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
  const setError = useCallback((error: string, id = scope.current, session = capture.current, frame = identity.current) => setFeedback({agentId: id, captureSession: session, captureIdentity: frame, error}), []);
  const release = useCallback(() => {
    const previous = current.current;
    current.current = null; cancelPending();
    setGrant(null); setAcquiringScope(null);
    if (previous) sendRef.current({ type: "control_release", agent_id: previous.agentId, lease_token: previous.token, request_id: crypto.randomUUID() });
  }, []);
  const acquire = useCallback(() => {
    if (!allowed.current || pending.current || current.current) return;
    const session = capture.current;
    if (!session || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) { setError("Reconnect live view before taking control."); return; }
    // Read the renderer's committed frame at the click, not a render snapshot or
    // the latest queued/decoded network geometry.
    const stamp = stampGetter.current?.() ?? null;
    if (stampGetter.current && !stamp) { setError("Wait for a verified displayed frame before taking control."); return; }
    const frame = stamp ? `${stamp.capture_id}:${stamp.geometry_revision}` : null;
    const id = crypto.randomUUID();
    pending.current = { agentId: scope.current, captureSession: session, captureIdentity: frame, id, kind: "acquire", sentAt: performance.now() };
    setAcquiringScope({agentId: scope.current, captureSession: session, captureIdentity: frame}); setError("");
    sendRef.current({ type: "control_acquire", agent_id: scope.current, capture_session: session, ...stamp, request_id: id });
  }, [setError]);
  useEffect(() => {
    const fail = (message: string) => setError(message, agentId, captureSession, captureIdentity);
    const ownsScope = (value: CaptureScope) => value.agentId === agentId && value.captureSession === captureSession && value.captureIdentity === captureIdentity;
    // A click may read a newly committed display before React renders its
    // identity. Retain that matching request, but cancel any superseded scope.
    if (pending.current && !ownsScope(pending.current)) cancelPending();
    if (current.current && !ownsScope(current.current)) {
      const previous = current.current; current.current = null;
      sendRef.current({type:"control_release",agent_id:previous.agentId,lease_token:previous.token,request_id:crypto.randomUUID()});
    }
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
      pending.current = null; setAcquiringScope(null);
      const latest = stampGetter.current?.();
      const latestIdentity = latest ? `${latest.capture_id}:${latest.geometry_revision}` : null;
      const duration = message.expires_in_ms;
      if (message.status === "granted" && allowed.current && scope.current === agentId && request.captureSession === capture.current && request.captureIdentity === latestIdentity && typeof message.lease_token === "string" && typeof duration === "number" && Number.isFinite(duration) && duration > 0 && duration <= 30000) {
        if (request.kind === "heartbeat" && message.lease_token !== current.current?.token) { release(); fail("Control session changed. Take control again."); return; }
        // Count transit time against the local deadline; never extend from receipt alone.
        const next = { agentId, captureSession: request.captureSession, captureIdentity: request.captureIdentity, token: message.lease_token, deadline: request.sentAt + duration };
        // A late heartbeat's token is the current lease, which release() already returns.
        if (next.deadline <= performance.now()) { if (current.current?.token !== next.token) sendRef.current({ type: "control_release", agent_id: agentId, lease_token: next.token, request_id: crypto.randomUUID() }); release(); fail("Control confirmation arrived too late. Try again."); return; }
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
        const id = crypto.randomUUID(); pending.current = { agentId: active.agentId, captureSession: active.captureSession, captureIdentity: active.captureIdentity, id, kind: "heartbeat", sentAt: now };
        sendRef.current({ type: "control_heartbeat", agent_id: active.agentId, capture_session: active.captureSession, lease_token: active.token, request_id: id });
      }
    }, 500);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("vantyr-ws-event", onEvent); window.removeEventListener("vantyr-ws-status", onStatus);
      window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onVisibility);
      const previous = current.current;
      if (pending.current && ownsScope(pending.current)) cancelPending();
      if (previous && ownsScope(previous)) {
        current.current = null;
        sendRef.current({ type: "control_release", agent_id: previous.agentId, lease_token: previous.token, request_id: crypto.randomUUID() });
      }
    };
  }, [agentId, captureSession, captureIdentity, release, setError]);
  useEffect(() => () => {
    const previous = current.current; current.current = null; cancelPending();
    if (previous) sendRef.current({type:"control_release",agent_id:previous.agentId,lease_token:previous.token,request_id:crypto.randomUUID()});
  }, []);
  useEffect(() => { if (!enabled) release(); }, [enabled, release]);
  const token = enabled && grant?.agentId === agentId && grant.captureSession === captureSession && grant.captureIdentity === captureIdentity && grant.deadline > performance.now() ? grant.token : null;
  return { token, acquiring: acquiringScope?.agentId === agentId && acquiringScope.captureSession === captureSession && acquiringScope.captureIdentity === captureIdentity, error: feedback?.agentId === agentId && feedback.captureSession === captureSession && feedback.captureIdentity === captureIdentity ? feedback.error : "", acquire, release };
}
