// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountForm, unmountForms } from "@tests/support/formDom";
import { withQueryClient } from "@tests/support/queryClient";
import { AgentVitals } from "@/features/agent-detail/components/AgentVitals";
import type { Agent, AgentInfo } from "@/api/types";

const backend = vi.hoisted(() => ({ agentMetrics: vi.fn(), agentInternetBlockedGet: vi.fn() }));
vi.mock("@/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/api")>()), api: backend }));

const info = {
  cpu_cores: 12,
  memory_total_mb: 16384,
  memory_used_mb: 8192,
  adapters: [{ name: "Ethernet", description: "Intel", mac: "02-00-5E-10-00-01", ips: ["192.168.20.148"], gateways: [], dns: [] }],
} as unknown as AgentInfo;

function agent(online: boolean): Agent {
  return { id: "a1", name: "SITTING-ROOM", online, last_seen: new Date().toISOString() } as unknown as Agent;
}

function renderVitals(online: boolean, activity?: "afk") {
  return mountForm(
    withQueryClient(
      <AgentVitals
        agent={agent(online)}
        info={info}
        liveStatus={activity ? ({ activity } as never) : undefined}
        uptimeText="1d 0h"
        lastSeenText="5m ago"
        version="0.1.6"
      />,
    ),
  );
}

const rows = () =>
  Object.fromEntries(
    Array.from(document.querySelectorAll('[aria-label="Device summary"] > div')).map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent?.replace(/\s+/g, " ").trim(),
    ]),
  );

beforeEach(() => {
  backend.agentMetrics.mockReset().mockResolvedValue({ points: [{ cpu_pct: 41.6 }] });
  backend.agentInternetBlockedGet.mockReset().mockResolvedValue({ blocked: false });
});
afterEach(unmountForms);

describe("AgentVitals", () => {
  it("lists the live device facts in one summary strip", async () => {
    await renderVitals(true);
    await vi.waitFor(() => expect(rows().CPU).toBe("42% · 12 cores"));
    expect(rows()).toMatchObject({
      Session: "Active",
      Memory: "8 / 16 GB",
      Uptime: "1d 0h",
      IP: "192.168.20.148",
      Version: "v0.1.6",
      Internet: "Allowed",
    });
    expect(document.querySelector("[aria-label='Device summary']")?.tagName).toBe("DL");
  });

  it("shows away sessions and a blocked connection with their own tone", async () => {
    backend.agentInternetBlockedGet.mockResolvedValue({ blocked: true });
    await renderVitals(true, "afk");
    await vi.waitFor(() => expect(rows().Internet).toBe("Blocked"));
    expect(rows().Session).toBe("Away");
    const dd = (label: string) => Array.from(document.querySelectorAll("dt")).find((dt) => dt.textContent === label)!.nextElementSibling!;
    expect(dd("Session").className).toContain("text-warning");
    expect(dd("Internet").className).toContain("text-destructive");
  });

  it("drops live-only facts and reports last seen when the device is offline", async () => {
    await renderVitals(false);
    await vi.waitFor(() => expect(rows()["Last seen"]).toBe("5m ago"));
    expect(Object.keys(rows())).toEqual(["Memory", "Last seen", "IP", "Version", "Internet"]);
    expect(backend.agentMetrics).not.toHaveBeenCalled();
  });
});
