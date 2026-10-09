import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalTab } from "@/features/remote/components/TerminalTab";
import { RemoteClipboardPanel } from "@/features/remote/components/RemoteClipboardPanel";
import { createWsBus } from "@/api/wsBus";
import { withWsBus } from "@tests/support/wsBus";
import type { WsEvent } from "@/api/types";
import { DemoEnvironment } from "@/demo/DemoEnvironment";
import { demoAgents } from "@/demo/data";
import { useDemoViewerConnection } from "@/demo/demoViewerConnection";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("tells the terminal tab it is unavailable in the demo", async () => {
  await act(async () => root.render(<DemoEnvironment><TerminalTab agentId="a" /></DemoEnvironment>));
  expect(host.textContent).toContain("Unavailable in demo mode.");
});

it("labels the clipboard panel as simulated", async () => {
  await act(async () => root.render(withWsBus(<DemoEnvironment><RemoteClipboardPanel agentId="a" controlToken="t" supported /></DemoEnvironment>, createWsBus())));
  expect(host.querySelector('[role="note"]')?.textContent).toBe("Demo: clipboard is simulated.");
});

it("announces the fake fleet and answers control lease commands locally", async () => {
  vi.useFakeTimers();
  const events: WsEvent[] = [];
  const statuses: string[] = [];
  let send: (data: unknown) => void = () => {};
  function Harness() {
    send = useDemoViewerConnection({ onMessage: (event) => events.push(event), onStatusChange: (s) => statuses.push(s) }).send;
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(statuses).toEqual(["connecting", "connected"]);
  expect(events[0]).toMatchObject({ event: "init", agents: demoAgents });

  const online = demoAgents.find((a) => a.online)!.id;
  const offline = demoAgents.find((a) => !a.online)!.id;
  events.length = 0;
  await act(async () => { send({ type: "control_acquire", agent_id: online, request_id: "r1" }); await Promise.resolve(); });
  expect(events[0]).toMatchObject({ event: "control_lease", agent_id: online, request_id: "r1", status: "granted" });
  const token = (events[0] as unknown as { lease_token: string }).lease_token;
  await act(async () => { send({ type: "control_release", agent_id: online, lease_token: token }); await Promise.resolve(); });
  expect(events[1]).toMatchObject({ status: "released" });
  await act(async () => { send({ type: "control_acquire", agent_id: offline }); await Promise.resolve(); });
  expect(events[2]).toMatchObject({ status: "denied" });
});
