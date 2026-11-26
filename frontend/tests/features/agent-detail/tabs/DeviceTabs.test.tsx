import { withQueryClient } from "@tests/support/queryClient";
import { click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { testMock as vi } from "@tests/support/mock";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";

import type { AgentInfo } from "@/api/types";

const backend = (() => ({
  agentSoftware: vi.fn(),
  collectAgentSoftware: vi.fn(),
  agentMetrics: vi.fn(),
  agentInfo: vi.fn(),
}))();
const originalModule0 = await import("@/api");
await vi.mock("@/api", async () => ({ ...originalModule0, api: backend }));

const { SoftwareTab } = await import("@/features/agent-detail/tabs/SoftwareTab");
const { SpecsTab } = await import("@/features/agent-detail/tabs/SpecsTab");

const row = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  version: "1.0",
  publisher: "Acme",
  install_location: null,
  install_date: "20260110",
  captured_at: "2026-01-02T10:00:00Z",
  ...over,
});

beforeEach(() => {
  backend.agentSoftware.mockReset().mockResolvedValue({
    rows: [
      row("Alpha"),
      row("Beta", { publisher: "Contoso", install_date: "20260301" }),
      row("Gamma", { publisher: null, install_date: null }),
    ],
    last_captured_at: "2026-01-02T10:00:00Z",
  });
  backend.collectAgentSoftware.mockReset().mockResolvedValue({ ok: true });
  backend.agentMetrics.mockReset().mockResolvedValue({ points: [] });
  backend.agentInfo.mockReset().mockResolvedValue({ info: null });
});
afterEach(unmountForms);

const text = () => document.body.textContent ?? "";
const settle = () => act(async () => {});
const byLabel = (label: string) =>
  document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const rowNames = () =>
  Array.from(document.querySelectorAll("tbody tr")).map((r) => r.querySelector("td")?.textContent);

async function mount(node: React.ReactNode) {
  await mountForm(withQueryClient(node));
  await settle();
  await settle();
}

describe("SoftwareTab", () => {
  it("counts programs, sorts newest install first and says when the list was captured", async () => {
    await mount(<SoftwareTab agentId="a1" dashboardRole="operator" />);
    expect(text()).toContain("3 programs");
    expect(text()).toContain("Updated");
    expect(rowNames()).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("filters by name, version or publisher and reports how many matched", async () => {
    await mount(<SoftwareTab agentId="a1" dashboardRole="operator" />);
    await typeInto(
      document.querySelector('input[aria-label="Find software"]') as HTMLInputElement,
      "contoso",
    );
    expect(text()).toContain("1 of 3 programs");
    expect(rowNames()).toEqual(["Beta"]);
    await typeInto(
      document.querySelector('input[aria-label="Find software"]') as HTMLInputElement,
      "zzz",
    );
    expect(text()).toContain("No software matches “zzz”.");
  });

  it("explains an empty inventory, and tells viewers who can re-scan", async () => {
    backend.agentSoftware.mockResolvedValue({ rows: [], last_captured_at: null });
    await mount(<SoftwareTab agentId="a1" dashboardRole="operator" />);
    expect(text()).toContain("No inventory yet. Use Re-scan");
    unmountForms();
    await mount(<SoftwareTab agentId="a1" dashboardRole="viewer" />);
    expect(text()).toContain("An operator can re-scan this device.");
  });

  it("keeps re-scan for operators and admins and gates it for viewers", async () => {
    await mount(<SoftwareTab agentId="a1" dashboardRole="viewer" />);
    expect((byLabel("Re-scan needs the operator role") as HTMLButtonElement).disabled).toBe(true);
    unmountForms();
    await mount(<SoftwareTab agentId="a1" dashboardRole="operator" />);
    const rescan = byLabel("Re-scan this device") as HTMLButtonElement;
    expect(rescan.disabled).toBe(false);
    await click(rescan);
    expect(backend.collectAgentSoftware).toHaveBeenCalledWith("a1");
  });

  it("reports a failed load instead of an empty table, and retries", async () => {
    backend.agentSoftware.mockRejectedValueOnce(new Error("boom"));
    await mount(<SoftwareTab agentId="a1" dashboardRole="operator" />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load the software list",
    );
    await click(
      Array.from(document.querySelectorAll('[role="alert"] button')).find(
        (b) => b.textContent === "Try again",
      )!,
    );
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("3 programs");
  });

  it("says so when the device cannot report software", async () => {
    await mount(
      <SoftwareTab
        agentId="a1"
        agentInfo={{ capabilities: { software_inventory: "unsupported" } } as AgentInfo}
      />,
    );
    expect(text()).toContain("Inventory unavailable");
  });
});

const INFO: AgentInfo = {
  system_manufacturer: "Lenovo",
  system_model: "ThinkPad T14",
  os_name: "Windows 11 Pro",
  os_version: "23H2",
  current_user: "kid",
  cpu_brand: "Intel Core i7",
  cpu_cores: 12,
  memory_total_mb: 32768,
  system_serial: "PF3DEMO",
  install_path: "C:\\Program Files\\Vantyr\\agent.exe",
  capabilities: {
    remote_input: "supported",
    audio_capture: "limited",
    system_control: "unsupported",
  },
  drives: [
    { name: "C:", mount_point: "C:\\", file_system: "NTFS", total_gb: 500, available_gb: 100 },
    { name: "Data", mount_point: "D:\\", file_system: "exFAT", total_gb: 1000, available_gb: 50 },
  ],
  adapters: [
    {
      name: "Ethernet",
      mac: "02-00-5E-10-00-00",
      ips: ["10.0.2.20", "fe80::1"],
      gateways: ["10.0.2.1"],
      dns: ["1.1.1.1", "1.1.1.1"],
    },
    { name: "WiFi", ips: ["169.254.4.4"], gateways: [], dns: [] },
  ],
};

describe("SpecsTab", () => {
  it("leads with the device facts and groups the rest behind summaries", async () => {
    await mount(<SpecsTab agentId="a1" cachedInfo={INFO} />);
    expect(text()).toContain("Lenovo ThinkPad T14");
    expect(text()).toContain("Windows 11 Pro 23H2");
    expect(text()).toContain("Intel Core i7 · 12 cores");
    expect(text()).toContain("32 GB");
    const sections = Array.from(document.querySelectorAll("details > summary")).map(
      (s) => s.textContent,
    );
    expect(sections.some((s) => s?.includes("Hardware identifiers"))).toBe(true);
    expect(sections.some((s) => s?.includes("1 of 3 fully available"))).toBe(true);
    expect(Array.from(document.querySelectorAll("details")).every((d) => !d.open)).toBe(true);
  });

  it("shows free space per drive with an accessible usage bar", async () => {
    await mount(<SpecsTab agentId="a1" cachedInfo={INFO} />);
    expect(text()).toContain("100.0 GB free of 500.0 GB");
    const bar = byLabel("Data usage");
    expect(bar?.getAttribute("aria-valuenow")).toBe("95");
    expect(bar?.getAttribute("aria-valuetext")).toContain("95% used");
    expect(text()).toContain("2 drives");
  });

  it("puts the connected adapter first, folds the self-assigned one away and dedupes DNS", async () => {
    await mount(<SpecsTab agentId="a1" cachedInfo={INFO} />);
    expect(byLabel("Copy MAC address 02-00-5E-10-00-00")).not.toBeNull();
    expect(byLabel("Copy IPv4 address 10.0.2.20")).not.toBeNull();
    expect(document.querySelectorAll('[aria-label="Copy DNS address 1.1.1.1"]')).toHaveLength(1);
    const folded = Array.from(document.querySelectorAll("details")).find((d) =>
      d.textContent?.includes("Not connected & local"),
    )!;
    expect(folded.textContent).toContain("WiFi");
    expect(folded.open).toBe(false);
  });

  it("copies an identifier and confirms it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount(<SpecsTab agentId="a1" cachedInfo={INFO} />);
    await click(byLabel("Copy IPv4 address 10.0.2.20")!);
    expect(writeText).toHaveBeenCalledWith("10.0.2.20");
    expect(text()).toContain("Copied");
  });

  it("says when copying is blocked instead of failing silently", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    await mount(<SpecsTab agentId="a1" cachedInfo={INFO} />);
    await click(byLabel("Copy IPv4 address 10.0.2.20")!);
    expect(text()).toContain("Couldn’t copy");
  });

  it("reports a failed system-info load and retries, keeping the resource history", async () => {
    backend.agentInfo.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ info: INFO });
    await mount(<SpecsTab agentId="a1" cachedInfo={null} />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load system info.",
    );
    expect(text()).toContain("Resource history");
    await click(
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Try again")!,
    );
    await settle();
    expect(text()).toContain("Lenovo ThinkPad T14");
  });

  it("says plainly when the device has not reported specs", async () => {
    await mount(<SpecsTab agentId="a1" cachedInfo={null} />);
    expect(text()).toContain("This device hasn’t reported its specs yet.");
  });
});
