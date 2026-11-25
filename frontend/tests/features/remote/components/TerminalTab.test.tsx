// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { click, mountForm, unmountForms } from "@tests/support/formDom";
import { TerminalTab } from "@/features/remote/components/TerminalTab";
import { RemoteEnvironmentContext, realRemoteEnvironment } from "@/features/remote/hooks/useRemoteEnvironment";

// xterm needs a real canvas/layout; these tests are about the tab around it.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80; rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    writeln() {}
    write() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send() {}
  close() { this.readyState = 3; }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  unmountForms();
  vi.unstubAllGlobals();
});

const text = () => document.body.textContent ?? "";
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const button = (name: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

describe("TerminalTab", () => {
  it("requires a fresh start after changing devices", async () => {
    function Harness() {
      const [id, setId] = useState("a1");
      return <><button onClick={() => setId("a2")}>Switch device</button><TerminalTab agentId={id} dashboardRole="operator" /></>;
    }
    await mountForm(<Harness />);
    await click(button("Start terminal")!);
    await settle();
    await click(button("Switch device")!);
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].readyState).toBe(3);
    expect(text()).toContain("Not started");
    await click(button("Start terminal")!);
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1].url).toContain("agent_id=a2");
  });

  it("requires a fresh start after the device goes offline and returns", async () => {
    function Harness() {
      const [online, setOnline] = useState(true);
      return <><button onClick={() => setOnline((value) => !value)}>Toggle connection</button><TerminalTab agentId="a1" agentOnline={online} dashboardRole="operator" /></>;
    }
    await mountForm(<Harness />);
    await click(button("Start terminal")!);
    await settle();
    await click(button("Toggle connection")!);
    await click(button("Toggle connection")!);
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].readyState).toBe(3);
    expect(button("Start terminal")).toBeDefined();
  });
  it("opens no shell until Start terminal is pressed", async () => {
    await mountForm(<TerminalTab agentId="a1" dashboardRole="operator" />);
    await settle();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(text()).toContain("Not started");
    expect(text()).toContain("It closes when you leave this tab.");
    await click(button("Start terminal")!);
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toContain("agent_id=a1");
  });

  it("follows the connection: connecting, connected, ended with an explicit new session", async () => {
    await mountForm(<TerminalTab agentId="a1" dashboardRole="admin" />);
    await click(button("Start terminal")!);
    await settle();
    expect(text()).toContain("Connecting…");
    expect(button("Cancel")).toBeDefined();
    const socket = FakeSocket.instances[0];
    await act(async () => { socket.readyState = 1; socket.onopen?.(); });
    expect(text()).toContain("Connected");
    expect(button("End session")).toBeDefined();
    await act(async () => { socket.onmessage?.({ data: JSON.stringify({ type: "terminal_exit" }) }); socket.onclose?.(); });
    expect(text()).toContain("Session ended");
    expect(FakeSocket.instances).toHaveLength(1);
    await click(button("New session")!);
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("offers Reconnect after a dropped connection and never reconnects by itself", async () => {
    await mountForm(<TerminalTab agentId="a1" dashboardRole="admin" />);
    await click(button("Start terminal")!);
    await settle();
    const socket = FakeSocket.instances[0];
    await act(async () => { socket.onopen?.(); socket.onclose?.(); });
    await settle();
    expect(text()).toContain("Connection lost");
    expect(FakeSocket.instances).toHaveLength(1);
    await click(button("Reconnect")!);
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("says when the server refused the connection and offers Retry", async () => {
    await mountForm(<TerminalTab agentId="a1" dashboardRole="admin" />);
    await click(button("Start terminal")!);
    await settle();
    await act(async () => { FakeSocket.instances[0].onclose?.(); });
    expect(text()).toContain("Refused.");
    expect(button("Retry")).toBeDefined();
  });

  it("ends the session back to the start screen and closes the socket", async () => {
    await mountForm(<TerminalTab agentId="a1" dashboardRole="admin" />);
    await click(button("Start terminal")!);
    await settle();
    const socket = FakeSocket.instances[0];
    await act(async () => { socket.onopen?.(); });
    await click(button("End session")!);
    expect(socket.readyState).toBe(3);
    expect(text()).toContain("Not started");
  });

  it("is blocked for viewers, offline devices, missing capability and the demo", async () => {
    await mountForm(<TerminalTab agentId="a1" dashboardRole="viewer" />);
    expect(text()).toContain("Operators only.");
    unmountForms();
    await mountForm(<TerminalTab agentId="a1" agentOnline={false} dashboardRole="admin" />);
    expect(text()).toContain("The device is offline.");
    unmountForms();
    await mountForm(<TerminalTab agentId="a1" dashboardRole="admin" agentInfo={{ capabilities: { terminal: "unsupported" } } as never} />);
    expect(text()).toContain("Terminal unavailable");
    unmountForms();
    await mountForm(
      <RemoteEnvironmentContext.Provider value={{ ...realRemoteEnvironment, terminalUnavailable: "Unavailable in demo mode." }}>
        <TerminalTab agentId="a1" dashboardRole="admin" />
      </RemoteEnvironmentContext.Provider>,
    );
    expect(text()).toContain("Unavailable in demo mode.");
    expect(button("Start terminal")).toBeUndefined();
  });
});
