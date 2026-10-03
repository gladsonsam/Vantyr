import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { RecallPage } from "../../pages/RecallPage";
vi.mock("../../lib/api", () => ({ api: { agentsOverview: async () => ({agents: []}), historyDevices: async () => ({agent_ids: []}) } }));
vi.mock("../ui/console", () => ({ Box: ({children}: {children: ReactNode}) => <div>{children}</div>, Header: () => null, ContentLayout: ({children}: {children: ReactNode}) => <div>{children}</div>, Select: ({selectedOption}: {selectedOption: {label: string} | null}) => <span>{selectedOption?.label}</span> }));
vi.mock("./RecallDayPanel", () => ({ RecallDayPanel: () => null }));
vi.mock("./RecallView", () => ({ RecallView: (props: { agentPicker: ReactNode; agentId: string; initialAtIso: string; initialDay: string; initialMonitor: number; onStateChange: (s: unknown) => void }) => <div>{props.agentPicker}<output>{JSON.stringify([props.agentId, props.initialDay, props.initialAtIso, props.initialMonitor])}</output><button onClick={() => props.onStateChange({day: "2026-09-04", atMs: Date.parse("2026-09-04T12:00:00Z"), monitor: 2})}>sync</button></div> }));
function Navigation() {
  const navigate = useNavigate(); const location = useLocation();
  return <><span id="url">{location.search}</span><button onClick={() => navigate("?agent=b&day=2026-09-02&at=2026-09-02T11:00:00Z&monitor=1")}>other</button><button onClick={() => navigate(-1)}>back</button><button onClick={() => navigate(1)}>forward</button></>;
}
it("restores all shared fields on links and Back/Forward, cancelling pending URL writes", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  const click = async (text: string) => act(async () => { [...el.querySelectorAll("button")].find(b => b.textContent === text)!.click(); });
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/recall?agent=a&day=2026-09-01&at=2026-09-01T10:00:00Z&monitor=0"]}><Navigation/><RecallPage/></MemoryRouter>));
    const state = () => JSON.parse(el.querySelector("output")!.textContent!);
    expect(state()).toEqual(["a", "2026-09-01", "2026-09-01T10:00:00Z", 0]);
    await click("sync"); await click("other");
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(state()).toEqual(["b", "2026-09-02", "2026-09-02T11:00:00Z", 1]);
    await click("back"); expect(state()[0]).toBe("a");
    await click("forward"); expect(state()[0]).toBe("b");
    await click("sync"); await act(async () => { vi.advanceTimersByTime(600); });
    expect(el.querySelector("#url")!.textContent).toContain("monitor=2");
    // Internal replace writes do not reset the mounted view to its own seed.
    expect(state()[3]).toBe(1);
  } finally { act(() => root.unmount()); el.remove(); vi.useRealTimers(); }
});

it("identifies unavailable linked agents and explains how to recover", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const el = document.createElement("div"); const root = createRoot(el);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={["/recall?agent=deleted-device"]}><RecallPage/></MemoryRouter>));
    expect(el.querySelector('[role="status"]')?.textContent).toContain("unavailable or has no recorded Recall history");
    expect(el.textContent).toContain("Unavailable agent (deleted-device)");
    expect(el.textContent).toContain("No agents with Recall history are currently available");
  } finally { act(() => root.unmount()); }
});
