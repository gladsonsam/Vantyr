import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { DeviceRow } from "@/features/devices/lib/deviceModel";

const conn = (kind: "agent" | "dns" | "proxy", state: "connected" | "stale" | "none") => ({
  kind,
  state,
  lastSeenAt: null,
  provenance: state === "none" ? null : kind,
  capabilities: [],
});
const device = (
  key: string,
  label: string,
  states: [
    "connected" | "stale" | "none",
    "connected" | "stale" | "none",
    "connected" | "stale" | "none",
  ],
): DeviceRow => ({
  key,
  origin: "household",
  deviceId: key,
  agentId: states[0] === "none" ? null : "a1",
  label,
  type: "computer",
  people: [],
  shared: false,
  connections: {
    agent: conn("agent", states[0]),
    dns: conn("dns", states[1]),
    proxy: conn("proxy", states[2]),
  },
});

const rows = [
  device("tv", "Living room TV", ["none", "connected", "none"]),
  device("desktop", "Shared desktop", ["connected", "connected", "stale"]),
];
mock.module("@/features/devices/hooks/useDeviceRows", () => ({
  useDeviceRows: () => ({ rows, loading: false, hasHousehold: true }),
}));

const { DeviceLayout } = await import("@/features/devices/DeviceLayout");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function open(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/devices/:deviceKey" element={<DeviceLayout />}>
            <Route index element={<div>overview</div>} />
            <Route path="agent" element={<div>agent page</div>} />
            <Route path="dns" element={<div>dns page</div>} />
            <Route path="proxy" element={<div>proxy page</div>} />
          </Route>
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const tabs = () => [...host.querySelectorAll("[role=tab]")].map((t) => t.textContent);

describe("DeviceLayout", () => {
  it("gives a DNS-only device just Overview and DNS", async () => {
    await open("/devices/tv");
    expect(tabs()).toEqual(["Overview", "DNS"]);
  });

  it("gives a device with every connection a page for each", async () => {
    await open("/devices/desktop");
    expect(tabs()).toEqual(["Overview", "Agent", "DNS", "Proxy"]);
  });

  it("keeps a page for a connection that is not reporting, since it is still the device's", async () => {
    await open("/devices/desktop/proxy");
    expect(host.textContent).toContain("proxy page");
  });

  it("sends a connection the device lacks back to its overview", async () => {
    await open("/devices/tv/proxy");
    expect(host.textContent).toContain("overview");
    expect(host.textContent).not.toContain("proxy page");
  });

  it("falls back to the home page for an unknown device", async () => {
    await open("/devices/nope");
    expect(host.textContent).toContain("home");
  });
});
