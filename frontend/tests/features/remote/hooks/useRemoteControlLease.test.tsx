import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { useRemoteControlLease, type CaptureStamp } from "@/features/remote/hooks/useRemoteControlLease";
import { createWsBus } from "@/api/wsBus";
import type { WsEvent } from "@/api/types";
import { withWsBus } from "@tests/support/wsBus";
const wsBus = createWsBus();
let state: ReturnType<typeof useRemoteControlLease>, root: Root, host: HTMLDivElement;
const send = vi.fn();
const captureSession = "5e6334d6-9b8f-4dc5-8ef0-b3ff5c53126b";
function Harness({ id, enabled = true, session = captureSession, getter }: { id: string; enabled?: boolean; session?: string | null; getter?: () => CaptureStamp | null }) { const value = useRemoteControlLease(id, enabled, send, {captureSession: session, getCaptureStamp: getter}); useEffect(()=>{state=value;},[value]); return <span>{value.token ?? "none"}</span>; }
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); send.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
function render(id = "a", enabled = true, session: string | null = captureSession) { act(() => root.render(withWsBus(<Harness id={id} enabled={enabled} session={session} />, wsBus))); }
function event(detail: Record<string, unknown>) { act(() => wsBus.emit({ event: "control_lease", ...detail } as unknown as WsEvent)); }
function acquire() { act(() => state.acquire()); return send.mock.calls[send.mock.calls.length - 1][0]; }
function grant(request: Record<string, unknown>, token = "lease") { event({ agent_id: request.agent_id, request_id: request.request_id, status: "granted", lease_token: token, expires_in_ms: 15000 }); }
it("waits for its own server grant and sends bounded heartbeats", () => {
  render(); const request = acquire(); expect(request.capture_session).toBe(captureSession); expect(state.token).toBeNull(); expect(state.acquiring).toBe(true);
  grant({ ...request, request_id: "another request" }); expect(state.token).toBeNull(); expect(send).toHaveBeenCalledTimes(1);
  grant(request); expect(state.token).toBe("lease");
  act(() => vi.advanceTimersByTime(5000)); expect(send.mock.calls[send.mock.calls.length - 1][0]).toMatchObject({ type: "control_heartbeat", agent_id: "a", lease_token: "lease" });
  const heartbeat = send.mock.calls[send.mock.calls.length - 1][0]; grant(heartbeat);
  act(() => vi.advanceTimersByTime(5000)); expect(state.token).toBe("lease");
});
it("releases a late heartbeat grant exactly once", () => {
  render(); grant(acquire()); act(() => vi.advanceTimersByTime(5000)); const heartbeat = send.mock.calls[send.mock.calls.length - 1][0]; send.mockClear();
  act(() => vi.advanceTimersByTime(1500)); event({ agent_id: heartbeat.agent_id, request_id: heartbeat.request_id, status: "granted", lease_token: "lease", expires_in_ms: 1000 });
  expect(state.token).toBeNull(); expect(state.error).toContain("too late");
  expect(send.mock.calls.filter(([message]) => message.type === "control_release")).toHaveLength(1);
});
it("releases on timeout and cannot revive with a late grant", () => {
  render(); const request = acquire(); act(() => vi.advanceTimersByTime(5000)); expect(state.token).toBeNull(); expect(state.error).toContain("timed out");
  grant(request); expect(state.token).toBeNull(); expect(send.mock.calls[send.mock.calls.length - 1][0]).toMatchObject({ type: "control_release", lease_token: "lease" });
});
it("ends control on blur, viewer disconnect, permissions removal and agent switch", () => {
  render(); grant(acquire()); act(() => window.dispatchEvent(new Event("blur"))); expect(state.token).toBeNull();
  grant(acquire()); act(() => wsBus.emitStatus("disconnected")); expect(state.token).toBeNull();
  grant(acquire()); render("a", false); expect(state.token).toBeNull();
  render(); grant(acquire()); render("b"); expect(state.token).toBeNull(); expect(send.mock.calls[send.mock.calls.length - 1][0]).toMatchObject({type: "control_release", agent_id: "a"});
});
it("releases a cancelled acquisition for the old device without affecting the new one", () => {
  render(); const old = acquire(); render("b"); const current = acquire(); grant(current, "new"); grant(old, "old");
  expect(state.token).toBe("new"); expect(send.mock.calls[send.mock.calls.length - 1][0]).toMatchObject({type: "control_release", agent_id: "a", lease_token: "old"});
});
it("keeps denial feedback and rejects an invalid grant", () => {
  render(); const request = acquire(); event({ agent_id: "a", request_id: request.request_id, status: "denied", error: "Another operator controls this device" });
  expect(state.token).toBeNull(); expect(state.error).toContain("Another operator");
  render("b"); expect(state.error).toBe(""); render("a");
  const retry = acquire(); event({agent_id: "a", request_id: retry.request_id, status: "granted", lease_token: "lease", expires_in_ms: Infinity}); expect(state.token).toBeNull();
});

it("requires a live capture session and cannot carry a lease to a replacement stream", () => {
  render("a", true, null); act(() => state.acquire()); expect(send).not.toHaveBeenCalled(); expect(state.error).toContain("Reconnect");
  render(); const previous = acquire(); grant(previous); expect(state.token).toBe("lease");
  const nextSession = "ca34b816-886d-431e-bd46-31d6b1e4dcb8";
  render("a", true, nextSession); expect(state.token).toBeNull(); expect(send.mock.calls[send.mock.calls.length - 1]?.[0]).toMatchObject({type:"control_release",lease_token:"lease"});
  const request = acquire(); expect(request.capture_session).toBe(nextSession); grant(request,"replacement"); expect(state.token).toBe("replacement");
});
it("releases a delayed grant for a cancelled capture session", () => {
  render(); const previous = acquire(); render("a",true,"ca34b816-886d-431e-bd46-31d6b1e4dcb8"); const next = acquire();
  grant(next,"current"); grant(previous,"obsolete"); expect(state.token).toBe("current");
  expect(send.mock.calls[send.mock.calls.length - 1]?.[0]).toMatchObject({type:"control_release",lease_token:"obsolete"});
});

it("clears pending acquisition UI on capture switch and reacquires while a late old grant is released", () => {
  render(); const old = acquire(); expect(state.acquiring).toBe(true);
  render("a",true,"ca34b816-886d-431e-bd46-31d6b1e4dcb8"); expect(state.acquiring).toBe(false); expect(state.error).toBe("");
  const next=acquire(); expect(state.acquiring).toBe(true); grant(old,"old"); expect(state.acquiring).toBe(true); expect(state.token).toBeNull();
  grant(next,"current"); expect(state.acquiring).toBe(false); expect(state.token).toBe("current");
});
it("does not expose denial feedback from a previous capture session", () => {
  render(); const old=acquire(); event({agent_id:"a",request_id:old.request_id,status:"denied",error:"Old monitor was unavailable"}); expect(state.error).toContain("Old monitor");
  render("a",true,"ca34b816-886d-431e-bd46-31d6b1e4dcb8"); expect(state.error).toBe(""); expect(state.acquiring).toBe(false);
});

it("reads the committed displayed stamp at click and rejects its late grant after the display changes", () => {
  let displayed: CaptureStamp | null = {capture_id:captureSession,geometry_revision:1};
  const getter=()=>displayed;
  const show=()=>act(()=>root.render(withWsBus(<Harness id="a" getter={getter}/>, wsBus)));
  show(); displayed={capture_id:captureSession,geometry_revision:2};
  const old=acquire(); expect(old).toMatchObject({capture_id:captureSession,geometry_revision:2});
  displayed={capture_id:captureSession,geometry_revision:3}; show(); expect(state.acquiring).toBe(false);
  const next=acquire(); grant(old,"obsolete"); expect(state.acquiring).toBe(true);expect(state.token).toBeNull();
  grant(next,"current"); expect(state.token).toBe("current");
  expect(send.mock.calls.some(call=>call[0].type==="control_release"&&call[0].lease_token==="obsolete")).toBe(true);
});
it("retains control across new frame objects of the same identity, but releases for a new revision", () => {
  let displayed: CaptureStamp | null={capture_id:captureSession,geometry_revision:1};
  const getter=()=>displayed;
  const show=()=>act(()=>root.render(withWsBus(<Harness id="a" getter={getter}/>, wsBus)));
  show(); grant(acquire()); const count=send.mock.calls.length;
  displayed={capture_id:captureSession,geometry_revision:1};show();expect(state.token).toBe("lease");expect(send).toHaveBeenCalledTimes(count);
  displayed={capture_id:captureSession,geometry_revision:2};show();expect(state.token).toBeNull();expect(state.error).toBe("");
  expect(send.mock.calls[send.mock.calls.length - 1]?.[0]).toMatchObject({type:"control_release",lease_token:"lease"});
  displayed=null;show();act(()=>state.acquire());expect(state.error).toContain("verified displayed frame");
});
