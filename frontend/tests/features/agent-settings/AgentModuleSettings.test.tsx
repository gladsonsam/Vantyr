import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeviceModuleStatus, ModuleStopRequest } from "@/api/types";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { AgentModuleSettings } from "@/features/agent-settings/AgentModuleSettings";
const api = vi.hoisted(() => ({ agentModules: vi.fn(), disableAgentModule: vi.fn() }));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e) }));
let host: HTMLDivElement, root: Root, queryClient = createTestQueryClient();
const stopRequest = (request: Partial<ModuleStopRequest> & Pick<ModuleStopRequest, "command_id" | "module" | "expected_revision" | "status">): ModuleStopRequest => ({ agent_id: "device", error: null, created_at: "2026-10-03T00:00:00Z", acknowledged_at: null, persisted: false, stopped: false, stop_status: "unconfirmed", pending: true, ...request });
const report = (): DeviceModuleStatus => ({ online: false, reported_at: "2026-10-03T00:00:00Z", authorization_current: true, pending: [], state: { type: "module_states", schema_version: 1, revision: 5, modules: [
  { module: "recall", enabled: true, available: true, revision: 5, authorization_required: false },
  { module: "keyboard_text", enabled: false, available: true, revision: 0, authorization_required: true },
] } });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); queryClient = createTestQueryClient(); api.agentModules.mockReset(); api.disableAgentModule.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(id = "device", canOperate = true) { await act(async () => root.render(withQueryClient(<AgentModuleSettings agentId={id} canOperate={canOperate} />, queryClient))); }
const button = (text: string) => [...host.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") ?? b.textContent) === text)!;
it("queues an offline stop with the reported module revision and waits for confirmation", async () => {
  const status = report(); api.agentModules.mockResolvedValue(status);
  api.disableAgentModule.mockImplementation(async (_id, body) => { const request = stopRequest({ ...body, status: "queued" }); status.pending = [request]; return request; });
  await render(); expect(button("Stop Keyboard text")).toBeUndefined();
  await act(async () => button("Stop Recall recordings").click());
  expect(api.disableAgentModule).toHaveBeenCalledWith("device", { module: "recall", expected_revision: 5, command_id: expect.any(String) });
  expect(host.textContent).toContain("Queued; waiting for device confirmation");
  expect(host.textContent).not.toContain("Permission revocation confirmed");
  expect(button("Stop Recall recordings").disabled).toBe(true);
});
it("shows unknown permissions and request failures without an enable control", async () => {
  api.agentModules.mockResolvedValue({ state: null, online: true, reported_at: null, pending: [] }); await render();
  expect(host.textContent).toContain("Permission status unavailable"); expect([...host.querySelectorAll("button")].some(b => /Enable/.test(b.textContent ?? ""))).toBe(false);
  api.agentModules.mockResolvedValue(report()); await act(async () => button("Refresh").click());
  api.disableAgentModule.mockRejectedValue(new Error("offline queue unavailable")); await act(async () => button("Stop Recall recordings").click());
  expect(host.textContent).toContain("offline queue unavailable"); expect(button("Stop Recall recordings").disabled).toBe(false);
});
it("rejects late results for another device and hides operator actions for viewers", async () => {
  let resolve!: (status: DeviceModuleStatus) => void;
  api.agentModules.mockImplementationOnce(() => new Promise<DeviceModuleStatus>(r => { resolve = r; })).mockResolvedValue({ state: null, online: false, reported_at: null, pending: [] });
  await render("old"); await render("new", false); await act(async () => resolve(report()));
  expect(host.textContent).not.toContain("Recall recordings"); expect([...host.querySelectorAll("button")].map(b => b.getAttribute("aria-label"))).toEqual(["What module states mean", "Refresh"]);
});
it("distinguishes a previous connection report and persisted revocation from worker shutdown", async () => {
  const status = report(); status.online = true; status.authorization_current = false;
  status.pending = [stopRequest({ command_id: "stop", module: "recall", expected_revision: 5, status: "disabled", persisted: true, stopped: false, stop_status: "local_barrier_timeout" })];
  api.agentModules.mockResolvedValue(status); await render();
  expect(host.textContent).toContain("earlier connection");
  expect(host.textContent).toContain("On · earlier report");
  expect(host.textContent).toContain("Permission revocation confirmed");
  expect(host.textContent).toContain("Some local operations are still finishing");
  expect(host.textContent).not.toContain("Device confirmed worker shutdown");
});
it("retries the same persisted stop request without targeting a later local grant", async () => {
  const status = report(); status.online = true;
  status.pending = [stopRequest({ command_id: "existing-stop", module: "recall", expected_revision: 3, status: "sent" })];
  api.agentModules.mockResolvedValue(status);
  api.disableAgentModule.mockResolvedValue(status.pending[0]); await render();
  await act(async () => button("Retry Recall recordings stop").click());
  expect(api.disableAgentModule).toHaveBeenCalledWith("device", { module: "recall", expected_revision: 3, command_id: "existing-stop" });
});

it("groups modules, counts what is on and keeps stoppable rows to the ones the device reports as on", async () => {
  const status = report(); status.state!.modules.push({ module: "terminal", enabled: false, available: false, revision: 0, authorization_required: true });
  api.agentModules.mockResolvedValue(status); await render();
  expect(host.textContent).toContain("1 of 2 modules on at last report");
  expect(host.textContent).toContain("Offline · last report");
  const monitoring = button("Monitoring1 of 2 on"); expect(monitoring.getAttribute("aria-expanded")).toBe("true");
  const device = button("Device access0 of 1 on"); expect(device.getAttribute("aria-expanded")).toBe("false");
  expect(host.textContent).toContain("On · last report"); expect(host.textContent).not.toContain("Unavailable");
  await act(async () => device.click());
  expect(device.getAttribute("aria-expanded")).toBe("true"); expect(host.textContent).toContain("Unavailable");
  expect(button("Stop Terminal")).toBeUndefined(); expect(button("Stop Keyboard text")).toBeUndefined();
  await act(async () => monitoring.click()); expect(host.textContent).not.toContain("Keyboard text");
});
it("keeps the local-grant guidance visible and gives a viewer-free report no way to turn a module on", async () => {
  api.agentModules.mockResolvedValue(report()); await render();
  expect(host.textContent).toContain("Only the device can turn modules on");
  expect([...host.querySelectorAll("button")].some(b => /enable|turn on/i.test(b.textContent ?? ""))).toBe(false);
});
it("moves focus to the outcome when a stop removes the row's button", async () => {
  const status = report(); status.online = true;
  api.agentModules.mockResolvedValue(status);
  api.disableAgentModule.mockImplementation(async (_id, body) => { status.state!.modules[0].enabled = false; return stopRequest({ ...body, status: "disabled", persisted: true, pending: false }); });
  await render(); await act(async () => button("Stop Recall recordings").click());
  expect(button("Stop Recall recordings")).toBeUndefined();
  expect(document.activeElement?.getAttribute("role")).toBe("status"); expect(document.activeElement?.textContent).toContain("Permission revocation confirmed");
});
it("shows a stop still waiting for the device as requested rather than off", async () => {
  const status = report(); status.online = true; status.pending = [stopRequest({ command_id: "wait", module: "recall", expected_revision: 5, status: "sent" })];
  api.agentModules.mockResolvedValue(status); await render();
  expect(host.textContent).toContain("Stop requested"); expect(button("Stop Recall recordings").disabled).toBe(true);
});
