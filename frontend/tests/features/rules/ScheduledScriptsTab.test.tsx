import { createTabHarness } from "@tests/support/ruleTab";
import { click } from "@tests/support/formDom";
import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { Agent, AgentGroup, ScheduledScript, ScheduledScriptEvent } from "@/api/types";

const api = (() => ({
  scheduledScriptsList: vi.fn(),
  scheduledScriptsCreate: vi.fn(async () => ({ id: 9 })),
  scheduledScriptsUpdate: vi.fn(async () => ({ ok: true })),
  scheduledScriptsDelete: vi.fn(async () => ({ ok: true })),
  scheduledScriptsTrigger: vi.fn(async () => ({ ok: true, agent_count: 3 })),
  scheduledScriptEventsAll: vi.fn(),
  scheduledScriptEventsForScript: vi.fn(),
  capabilities: vi.fn(async () => ({ remote_script: true, scheduler_timezone: "Australia/Perth" })),
}))();
await vi.mock("@/api", () => ({
  api,
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  apiUrl: (p: string) => p,
}));

const { ScheduledScriptsTab } = await import("@/features/rules/ScheduledScriptsTab");

const script = (id: number, patch: Partial<ScheduledScript> = {}): ScheduledScript => ({
  id,
  name: `Script ${id}`,
  shell: "powershell",
  script: "dir",
  timeout_secs: 60,
  enabled: true,
  created_at: "",
  updated_at: "",
  scopes: [{ kind: "all", group_id: null, agent_id: null }],
  schedules: [{ frequency: "daily", day_of_week: null, fire_minute: 180 }],
  ...patch,
});
const scripts: ScheduledScript[] = [
  script(1, { name: "Collect diagnostics" }),
  script(2, {
    name: "Clear temp",
    shell: "cmd",
    scopes: [{ kind: "group", group_id: "g1", agent_id: null }],
    schedules: [
      { frequency: "weekly", day_of_week: 1, fire_minute: 120 },
      { frequency: "hourly", day_of_week: null, fire_minute: 5 },
    ],
  }),
  script(3, { name: "Spooler", enabled: false }),
];
const ev = (
  script_id: number,
  agent: string,
  status: string,
  time: string,
  output: string | null = null,
): ScheduledScriptEvent => ({
  script_id,
  agent_id: agent,
  agent_name: agent.toUpperCase(),
  status,
  expected_fire_time: time,
  output,
});
const feed = [
  ev(1, "a", "success", "2026-11-01T03:00:00Z"),
  ev(1, "b", "failed", "2026-11-01T03:00:00Z", "--- STDERR ---\nAccess denied"),
  ev(1, "c", "success", "2026-11-01T03:00:00Z"),
  ev(2, "a", "fired", "2026-11-01T02:00:00Z"),
];
const groups = [{ id: "g1", name: "Lab" }] as AgentGroup[];
const agents = [{ id: "a1", name: "Alpha" }] as Agent[];

const t = createTabHarness();
beforeEach(() => {
  t.setup();
  api.scheduledScriptsList.mockResolvedValue({ scripts });
  api.scheduledScriptEventsAll.mockResolvedValue({ rows: feed });
  api.scheduledScriptEventsForScript.mockResolvedValue({ rows: [] });
});
afterEach(async () => {
  await t.teardown();
  vi.clearAllMocks();
});

const render = () => t.render(<ScheduledScriptsTab groups={groups} agents={agents} />);
const items = () => t.items("Scheduled scripts");

describe("ScheduledScriptsTab list", () => {
  it("shows where each script runs, when, in which timezone, and how the last run went", async () => {
    await render();
    await act(async () => {});
    expect(items()).toHaveLength(3);
    expect(t.host.querySelector('[role="status"]')?.textContent).toBe("3 scripts · 2 on");
    const first = items()[0].textContent ?? "";
    expect(first).toContain("PowerShell");
    expect(first).toContain("All devices");
    expect(first).toContain("Every day at 03:00 · Australia/Perth");
    expect(first).toContain("1 failed, 2 succeeded");
    const second = items()[1].textContent ?? "";
    expect(second).toContain("CMD");
    expect(second).toContain("Group · Lab");
    expect(second).toContain("Mondays at 02:00, Every hour at :05 · Australia/Perth");
    // A run that was only handed to a device is not reported as having run.
    expect(second).toContain("Sent, no result yet");
    expect(second).not.toContain("Succeeded");
    expect(items()[2].textContent).toContain("Off, won’t run on its schedule");
    expect(items()[2].textContent).toContain("No recent run");
  });

  it("says last-run results are unknown when the run feed fails, rather than 'no recent run'", async () => {
    api.scheduledScriptEventsAll.mockRejectedValue(new Error("502"));
    await render();
    await act(async () => {});
    expect(items()[0].textContent).toContain("Last run unknown");
    expect(items()[0].textContent).not.toContain("No recent run");
    expect(t.host.textContent).toContain("Couldn’t load how the last runs went");
  });

  it("invites adding the first script", async () => {
    api.scheduledScriptsList.mockResolvedValue({ scripts: [] });
    await render();
    expect(t.host.textContent).toContain("No scheduled scripts yet");
    await click(t.btn("New script", t.host)!);
    expect(t.dialog()?.querySelector("h2")?.textContent).toBe("New scheduled script");
  });

  it("says the load failed and retries", async () => {
    api.scheduledScriptsList.mockRejectedValueOnce(new Error("503")).mockResolvedValue({ scripts });
    await render();
    expect(t.host.textContent).toContain("Couldn’t load scheduled scripts: 503");
    expect(t.host.textContent).not.toContain("No scheduled scripts yet");
    await click(t.btn("Try again")!);
    expect(items()).toHaveLength(3);
  });
});

describe("ScheduledScriptsTab switch", () => {
  it("flips only enabled, and names the script when the server refuses", async () => {
    api.scheduledScriptsUpdate.mockRejectedValueOnce(new Error("Forbidden"));
    await render();
    await click(t.switchOf(items()[0]));
    expect(api.scheduledScriptsUpdate).toHaveBeenCalledWith(1, { enabled: false });
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t turn off “Collect diagnostics”: Forbidden",
    );
    expect(t.switchOf(items()[0]).getAttribute("aria-checked")).toBe("true");
  });
});

describe("ScheduledScriptsTab run now", () => {
  it("asks first, saying where it goes, and does not claim it ran", async () => {
    await render();
    await click(t.btn("Run Clear temp now")!);
    expect(api.scheduledScriptsTrigger).not.toHaveBeenCalled();
    const text = t.dialog()?.textContent ?? "";
    expect(text).toContain("Run “Clear temp” now?");
    expect(text).toContain("sent right away to Group · Lab");
    expect(text).toContain("runs in CMD");
    expect(text).toContain("Offline devices skip it");
    await click(t.btn("Cancel", t.dialog()!)!);
    expect(api.scheduledScriptsTrigger).not.toHaveBeenCalled();
    await click(t.btn("Run Clear temp now")!);
    await click(t.btn("Run now", t.dialog()!)!);
    expect(api.scheduledScriptsTrigger).toHaveBeenCalledWith(2);
    expect(t.dialog()).toBeNull();
    const notice = t.host.querySelector('p[role="status"]')?.textContent ?? "";
    expect(notice).toContain(
      "Sent “Clear temp” to its 3 devices. Offline devices skip it; results appear in Run history.",
    );
    expect(notice).not.toMatch(/ran|executed/i);
  });

  it("reports a refused run by name", async () => {
    api.scheduledScriptsTrigger.mockRejectedValueOnce(new Error("No agents in scope"));
    await render();
    await click(t.btn("Run Spooler now")!);
    await click(t.btn("Run now", t.dialog()!)!);
    expect(t.dialog()).toBeNull();
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t run “Spooler”: No agents in scope",
    );
  });
});

describe("ScheduledScriptsTab run history", () => {
  it("lists each device's result with what it printed", async () => {
    api.scheduledScriptEventsForScript.mockResolvedValue({
      rows: [
        ev(1, "b", "failed", "2026-11-01T03:00:00Z", "--- STDERR ---\nAccess denied"),
        ev(1, "a", "fired", "2026-11-01T02:00:00Z"),
        ev(1, "c", "skipped_offline", "2026-11-01T01:00:00Z"),
        ev(1, "d", "success", "2026-10-31T03:00:00Z", "ok"),
      ],
    });
    await render();
    await click(t.btn("Run history for Collect diagnostics")!);
    await act(async () => {});
    expect(api.scheduledScriptEventsForScript).toHaveBeenCalledWith(1, { limit: 200 });
    const text = t.dialog()?.textContent ?? "";
    expect(text).toContain("Run history · Collect diagnostics");
    expect(text).toContain("4 runs, newest first.");
    expect(text).toContain("Failed");
    expect(text).toContain("Access denied");
    expect(text).toContain("Sent, no result yet");
    expect(text).toContain("Waiting for the device to report back.");
    expect(text).toContain("Skipped, device offline");
    expect(text).toContain("The device was offline, so it wasn’t sent.");
  });

  it("collapses long output behind Show all output", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    api.scheduledScriptEventsForScript.mockResolvedValue({
      rows: [ev(1, "a", "success", "2026-11-01T03:00:00Z", long)],
    });
    await render();
    await click(t.btn("Run history for Collect diagnostics")!);
    await act(async () => {});
    expect(t.dialog()!.querySelector("pre")!.className).toContain("line-clamp-4");
    await click(t.btn("Show all output", t.dialog()!)!);
    expect(t.dialog()!.querySelector("pre")!.className).not.toContain("line-clamp-4");
    expect(t.btn("Show less", t.dialog()!)).toBeDefined();
  });

  it("says when the runs could not be loaded instead of 'no runs yet', and retries", async () => {
    api.scheduledScriptEventsForScript
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ rows: [] });
    await render();
    await click(t.btn("Run history for Collect diagnostics")!);
    await act(async () => {});
    expect(t.dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load this script’s runs: timeout",
    );
    expect(t.dialog()?.textContent).not.toContain("No runs yet");
    await click(t.btn("Try again", t.dialog()!)!);
    await act(async () => {});
    expect(t.dialog()?.textContent).toContain("No runs yet");
  });
});

describe("ScheduledScriptsTab delete, edit and create", () => {
  it("says where it stops running and that a sent run isn't recalled, and only deletes on confirm", async () => {
    await render();
    await t.openMenu("Clear temp");
    await click(t.menuItem("Delete script"));
    const text = t.dialog()?.textContent ?? "";
    expect(text).toContain("Delete “Clear temp”?");
    expect(text).toContain("It stops running on Group · Lab");
    expect(text).toContain("A run already sent isn’t recalled");
    expect(api.scheduledScriptsDelete).not.toHaveBeenCalled();
    await click(t.btn("Delete", t.dialog()!)!);
    expect(api.scheduledScriptsDelete).toHaveBeenCalledWith(2);
    expect(t.host.textContent).toContain("Deleted “Clear temp”.");
  });

  it("keeps the confirmation open with the reason when the delete fails", async () => {
    api.scheduledScriptsDelete.mockRejectedValueOnce(new Error("Not found"));
    await render();
    await t.openMenu("Spooler");
    await click(t.menuItem("Delete script"));
    await click(t.btn("Delete", t.dialog()!)!);
    expect(t.dialog()?.textContent).toContain("Couldn’t delete it: Not found");
  });

  it("opens the form filled in and reports a refused save inside the dialog", async () => {
    api.scheduledScriptsUpdate.mockRejectedValueOnce(new Error("script exceeds maximum size"));
    await render();
    await click(t.btn("Edit Collect diagnostics")!);
    expect(t.dialog()?.querySelector("h2")?.textContent).toBe("Edit script · Collect diagnostics");
    expect(document.querySelector<HTMLInputElement>("#script-name")!.value).toBe(
      "Collect diagnostics",
    );
    await click(t.btn("Save changes", t.dialog()!)!);
    expect(t.dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn’t save the script: script exceeds maximum size",
    );
    expect(t.host.querySelector('[role="alert"]')).toBeNull();
    await click(t.btn("Save changes", t.dialog()!)!);
    await act(async () => {});
    expect(api.scheduledScriptsUpdate).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        name: "Collect diagnostics",
        timeout_secs: 60,
        schedules: [{ frequency: "daily", fire_minute: 180, day_of_week: undefined }],
      }),
    );
    expect(t.dialog()).toBeNull();
    expect(t.host.textContent).toContain("Saved “Collect diagnostics”.");
  });
});
