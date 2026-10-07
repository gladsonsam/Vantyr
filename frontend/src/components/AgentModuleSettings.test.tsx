import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeviceModuleStatus } from "@/lib/modulePermissions";
import { AgentModuleSettings } from "./AgentModuleSettings";
const api = vi.hoisted(() => ({ agentModules: vi.fn(), disableAgentModule: vi.fn() }));
vi.mock("@/lib/api", () => ({ api, errorText: (e: unknown) => String(e) }));
let host: HTMLDivElement, root: Root;
const report = (): DeviceModuleStatus => ({ online: false, reported_at: "2026-10-03T00:00:00Z", pending: [], state: { schema_version: 1, revision: 5, modules: [
  { module: "recall", enabled: true, available: true, revision: 5, authorization_required: false },
  { module: "keyboard_text", enabled: false, available: true, revision: 0, authorization_required: true },
] } });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); api.agentModules.mockReset(); api.disableAgentModule.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(id = "device", canOperate = true) { await act(async () => root.render(<AgentModuleSettings agentId={id} canOperate={canOperate} />)); }
const button = (text: string) => [...host.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") ?? b.textContent) === text)!;
it("queues an offline stop with the reported module revision and waits for confirmation", async () => {
  const status = report(); api.agentModules.mockResolvedValue(status);
  api.disableAgentModule.mockImplementation(async (_id, body) => { const request = { ...body, status: "queued" }; status.pending = [request]; return request; });
  await render(); expect(button("Stop Keyboard text").disabled).toBe(true);
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
  expect(host.textContent).not.toContain("Locally authorized"); expect(host.querySelectorAll("button")).toHaveLength(1);
});
it("distinguishes a previous connection report and persisted revocation from worker shutdown", async () => {
  const status = report(); status.online = true; status.authorization_current = false;
  status.pending = [{ command_id: "stop", module: "recall", expected_revision: 5, status: "disabled", persisted: true, stopped: false, stop_status: "local_barrier_timeout" }];
  api.agentModules.mockResolvedValue(status); await render();
  expect(host.textContent).toContain("earlier connection");
  expect(host.textContent).toContain("Previously authorized");
  expect(host.textContent).toContain("Permission revocation confirmed");
  expect(host.textContent).toContain("Some local operations are still finishing");
  expect(host.textContent).not.toContain("Device confirmed worker shutdown");
});
it("retries the same persisted stop request without targeting a later local grant", async () => {
  const status = report(); status.online = true;
  status.pending = [{ command_id: "existing-stop", module: "recall", expected_revision: 3, status: "sent" }];
  api.agentModules.mockResolvedValue(status);
  api.disableAgentModule.mockResolvedValue(status.pending[0]); await render();
  await act(async () => button("Retry Recall recordings stop").click());
  expect(api.disableAgentModule).toHaveBeenCalledWith("device", { module: "recall", expected_revision: 3, command_id: "existing-stop" });
});
