import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { useRemoteControlLease } from "./useRemoteControlLease";
let state: ReturnType<typeof useRemoteControlLease>, root: Root, host: HTMLDivElement;
const send = vi.fn();
function Harness({ id, enabled = true }: { id: string; enabled?: boolean }) { state = useRemoteControlLease(id, enabled, send); return <span>{state.token ?? "none"}</span>; }
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); send.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
function render(id = "a", enabled = true) { act(() => root.render(<Harness id={id} enabled={enabled} />)); }
function event(detail: Record<string, unknown>) { act(() => window.dispatchEvent(new CustomEvent("vantyr-ws-event", { detail: { event: "control_lease", ...detail } }))); }
function acquire() { act(() => state.acquire()); return send.mock.calls[send.mock.calls.length - 1][0]; }
function grant(request: Record<string, unknown>, token = "lease") { event({ agent_id: request.agent_id, request_id: request.request_id, status: "granted", lease_token: token, expires_in_ms: 15000 }); }
it("waits for its own server grant and sends bounded heartbeats", () => {
  render(); const request = acquire(); expect(state.token).toBeNull(); expect(state.acquiring).toBe(true);
  grant({ ...request, request_id: "another request" }); expect(state.token).toBeNull(); expect(send).toHaveBeenCalledTimes(1);
  grant(request); expect(state.token).toBe("lease");
  act(() => vi.advanceTimersByTime(5000)); expect(send.mock.calls[send.mock.calls.length - 1][0]).toMatchObject({ type: "control_heartbeat", agent_id: "a", lease_token: "lease" });
  const heartbeat = send.mock.calls[send.mock.calls.length - 1][0]; grant(heartbeat);
  act(() => vi.advanceTimersByTime(5000)); expect(state.token).toBe("lease");
});
it("releases on timeout and cannot revive with a late grant", () => {
  render(); const request = acquire(); act(() => vi.advanceTimersByTime(5000)); expect(state.token).toBeNull(); expect(state.error).toContain("timed out");
  grant(request); expect(state.token).toBeNull(); expect(send.mock.calls[send.mock.calls.length - 1][0]).toMatchObject({ type: "control_release", lease_token: "lease" });
});
it("ends control on blur, viewer disconnect, permissions removal and agent switch", () => {
  render(); grant(acquire()); act(() => window.dispatchEvent(new Event("blur"))); expect(state.token).toBeNull();
  grant(acquire()); act(() => window.dispatchEvent(new CustomEvent("vantyr-ws-status", { detail: "disconnected" }))); expect(state.token).toBeNull();
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
  const retry = acquire(); event({agent_id: "a", request_id: retry.request_id, status: "granted", lease_token: "lease", expires_in_ms: Infinity}); expect(state.token).toBeNull();
});
