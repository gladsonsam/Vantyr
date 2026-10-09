import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { useWebSocket } from "@/api/useWebSocket";
vi.mock("@/api/serverSettings", () => ({buildViewerWsUrl: () => "wss://test/ws"}));
class Socket {
  static OPEN = 1; static sockets: Socket[] = [];
  readyState = 1; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: {data: string}) => void) | null = null;
  constructor() { Socket.sockets.push(this); }
  close() { this.readyState = 3; }
  send = vi.fn();
}
const messages = vi.fn(), statuses = vi.fn();
let host: HTMLDivElement, root: Root;
function Harness({enabled}: {enabled: boolean}) { useWebSocket({enabled, onMessage: messages, onStatusChange: statuses}); return null; }
beforeEach(() => { (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true; Socket.sockets = []; messages.mockClear(); statuses.mockClear(); vi.stubGlobal("WebSocket", Socket); host = document.createElement("div"); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
it("ignores open, message and close events from a superseded viewer socket", () => {
  act(() => root.render(<Harness enabled />)); const old = Socket.sockets[0];
  act(() => old.onopen?.()); act(() => root.render(<Harness enabled={false} />)); act(() => root.render(<Harness enabled />));
  const current = Socket.sockets[1]; act(() => current.onopen?.()); statuses.mockClear();
  act(() => { old.onclose?.(); old.onopen?.(); old.onmessage?.({data: JSON.stringify({event: "init", agents: []})}); });
  expect(statuses).not.toHaveBeenCalled(); expect(messages).not.toHaveBeenCalled();
  act(() => current.onmessage?.({data: JSON.stringify({event: "init", agents: []})})); expect(messages).toHaveBeenCalledTimes(1);
});
