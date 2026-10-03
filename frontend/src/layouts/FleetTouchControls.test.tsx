import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentCardGrid } from "../components/overview/AgentCardGrid";
import type { FleetRow } from "../components/overview/types";

it("activates a native checkbox through its label without navigating the device card", async () => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const row: FleetRow = { id: "pc", name: "Office PC", displayName: "Office PC", online: false,
    first_seen: "2026-10-01", last_seen: "2026-10-01", connected_at: null, last_connected_at: null, last_disconnected_at: null,
    appBlockEnabledCount: null, appBlockExamples: null, internetBlocked: null, internetBlockedSource: null,
    ip: "-", lastWindow: "-", os: "windows", status: "offline", statusLabel: "Offline", user: "-", version: null, updateNeeded: false };
  const select = vi.fn(), navigate = vi.fn();
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  const render = (busy = false) => act(async () => root.render(<AgentCardGrid filteredRows={[row]} onSelectAgent={navigate} onOpenScreen={() => {}} setPowerModal={() => {}}
    showSelection onToggleSelect={select} removalBusy={busy} />));
  try {
    await render();
    const input = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const label = el.querySelector<HTMLLabelElement>(".fleet-selection-control")!;
    expect(label.control).toBe(input); expect(input.getAttribute("aria-label")).toBe("Select Office PC");
    await act(async () => label.click()); expect(select).toHaveBeenCalledExactlyOnceWith("pc"); expect(navigate).not.toHaveBeenCalled();
    await render(true); select.mockClear();
    await act(async () => label.click()); expect(select).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); el.remove(); }
});
