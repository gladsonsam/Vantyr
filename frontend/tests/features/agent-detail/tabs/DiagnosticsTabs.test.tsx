import { withQueryClient } from "@tests/support/queryClient";
import { click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { testMock as vi } from "@tests/support/mock";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";

const backend = (() => ({
  agentLogSources: vi.fn(),
  agentLogTail: vi.fn(),
  runAgentScript: vi.fn(),
  capabilities: vi.fn(),
}))();
const originalModule0 = await import("@/api");
await vi.mock("@/api", async () => ({ ...originalModule0, api: backend }));
await vi.mock("@/features/logs/AuditTab", () => ({ AuditTab: () => <p>audit rows</p> }));

const { ApiError } = await import("@/api/client");
const { AgentLogsTab } = await import("@/features/agent-detail/tabs/AgentLogsTab");
const { ScriptsTab } = await import("@/features/agent-detail/tabs/ScriptsTab");

const LOG = "10:00:00 INFO started\n10:00:07 ERROR upload failed\n10:00:14 INFO done\n";
const clipboard = { writeText: vi.fn() };

beforeEach(() => {
  backend.agentLogSources.mockReset().mockResolvedValue({
    sources: [{ id: "agent", label: "Agent log", path: "C:\\Logs\\agent.log" }],
  });
  backend.agentLogTail.mockReset().mockResolvedValue({ kind: "agent", text: LOG });
  backend.runAgentScript.mockReset();
  backend.capabilities.mockReset().mockResolvedValue({ remote_script: true });
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
});
afterEach(unmountForms);

const text = () => document.body.textContent ?? "";
const settle = () => act(async () => {});
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name,
  ) as HTMLButtonElement | undefined;
const logBox = () =>
  document.querySelector('textarea[aria-label="Device log output"]') as HTMLTextAreaElement;

async function mount(node: React.ReactNode) {
  await mountForm(withQueryClient(<MemoryRouter>{node}</MemoryRouter>));
  await settle();
  await settle();
}

describe("AgentLogsTab", () => {
  it("shows the log with its state, line count and path, and polls only while auto-refresh is on", async () => {
    await mount(<AgentLogsTab agentId="a1" />);
    expect(logBox().value).toBe(LOG);
    expect(text()).toContain("Live · every 2 s");
    expect(text()).toContain("3 lines");
    expect(text()).toContain("C:\\Logs\\agent.log");
    await click(document.querySelector('[aria-label="Auto-refresh"]')!);
    expect(text()).toContain("Auto-refresh off");
  });

  it("filters lines, counts the matches, says when none match, and clears", async () => {
    await mount(<AgentLogsTab agentId="a1" />);
    const input = document.querySelector(
      'input[aria-label="Filter log lines"]',
    ) as HTMLInputElement;
    await typeInto(input, "error");
    expect(logBox().value).toBe("10:00:07 ERROR upload failed");
    expect(text()).toContain("1 of 3 lines");
    await typeInto(input, "nothing like this");
    expect(logBox().value).toBe("");
    expect(logBox().placeholder).toBe("No lines match this filter.");
    await click(button("Clear filter")!);
    expect(logBox().value).toBe(LOG);
  });

  it("copies what is shown, and says so", async () => {
    await mount(<AgentLogsTab agentId="a1" />);
    await typeInto(
      document.querySelector('input[aria-label="Filter log lines"]') as HTMLInputElement,
      "done",
    );
    await click(button("Copy")!);
    expect(clipboard.writeText).toHaveBeenCalledWith("10:00:14 INFO done");
    expect(text()).toContain("Copied");
  });

  it("explains a failed load, keeps the source picker, and retries", async () => {
    backend.agentLogTail.mockRejectedValue(new ApiError("Log unreadable", 403));
    await mount(<AgentLogsTab agentId="a1" />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load the log (auto-refresh paused). Log unreadable",
    );
    expect(logBox().placeholder).toBe("The log couldn’t be loaded.");
    backend.agentLogTail.mockResolvedValue({ kind: "agent", text: LOG });
    await click(
      Array.from(document.querySelectorAll('[role="alert"] button')).find(
        (b) => b.textContent === "Try again",
      )!,
    );
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(logBox().value).toBe(LOG);
  });

  it("says when nothing was logged and hides copy", async () => {
    backend.agentLogTail.mockResolvedValue({ kind: "agent", text: "" });
    await mount(<AgentLogsTab agentId="a1" />);
    expect(logBox().placeholder).toBe("Nothing has been logged yet.");
    expect(button("Copy")!.disabled).toBe(true);
  });

  it("switches to the audit log and back", async () => {
    await mount(<AgentLogsTab agentId="a1" />);
    await click(
      Array.from(document.querySelectorAll('[role="tab"]')).find(
        (t) => t.textContent === "Audit log",
      )!,
    );
    expect(text()).toContain("audit rows");
    expect(logBox()).toBeNull();
  });
});

describe("ScriptsTab", () => {
  const typeScript = (value: string) =>
    typeInto(document.querySelector('textarea[aria-label="Script"]') as HTMLTextAreaElement, value);

  it("does not run anything until Run script is pressed, and not an empty script", async () => {
    await mount(<ScriptsTab agentId="a1" dashboardRole="admin" />);
    expect(button("Run script")!.disabled).toBe(true);
    await typeScript("Get-Date");
    expect(backend.runAgentScript).not.toHaveBeenCalled();
    expect(button("Run script")!.disabled).toBe(false);
    expect(text()).toContain("recorded in the audit log");
  });

  it("claims nothing until the device replies, then reports the result", async () => {
    let reply: (v: unknown) => void = () => {};
    backend.runAgentScript.mockReturnValue(
      new Promise((resolve) => {
        reply = resolve;
      }),
    );
    await mount(<ScriptsTab agentId="a1" dashboardRole="operator" />);
    await typeScript("Get-Date");
    await click(button("Run script")!);
    expect(backend.runAgentScript).toHaveBeenCalledWith("a1", {
      shell: "powershell",
      script: "Get-Date",
      timeout_secs: 120,
    });
    expect(text()).toContain("Waiting for the device to reply");
    expect(button("Running…")!.disabled).toBe(true);
    expect(
      (document.querySelector('textarea[aria-label="Script"]') as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(document.querySelector('[aria-label="Script result"]')).toBeNull();

    await act(async () => reply({ ok: true, exit_code: 0, stdout: "Monday\n", stderr: "" }));
    await settle();
    const result = document.querySelector('[aria-label="Script result"]')!;
    expect(result.textContent).toContain("Finished · exit code 0");
    expect(result.querySelector('pre[aria-label="Output"]')?.textContent).toBe("Monday\n");
    expect(button("Run script")!.disabled).toBe(false);
  });

  it("shows a failing run's exit code and errors separately from output, and can clear the result", async () => {
    backend.runAgentScript.mockResolvedValue({
      ok: false,
      exit_code: 2,
      stdout: "partial",
      stderr: "bad thing",
    });
    await mount(<ScriptsTab agentId="a1" dashboardRole="admin" />);
    await typeScript("x");
    await click(button("Run script")!);
    await settle();
    const result = document.querySelector('[aria-label="Script result"]')!;
    expect(result.textContent).toContain("Failed · exit code 2");
    expect(result.querySelector('pre[aria-label="Errors"]')?.textContent).toBe("bad thing");
    await click(button("Clear result")!);
    expect(document.querySelector('[aria-label="Script result"]')).toBeNull();
  });

  it("reports a request that never reached the device", async () => {
    backend.runAgentScript.mockRejectedValue(new Error("Forbidden"));
    await mount(<ScriptsTab agentId="a1" dashboardRole="admin" />);
    await typeScript("x");
    await click(button("Run script")!);
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "The script didn’t run.",
    );
    expect(document.querySelector('[aria-label="Script result"]')).toBeNull();
  });

  it("clears the script only on request, and starts on a shell the platform has", async () => {
    await mount(
      <ScriptsTab
        agentId="a1"
        dashboardRole="admin"
        agentInfo={{ capabilities: { platform: "linux" } } as never}
      />,
    );
    expect(
      document.querySelector('textarea[aria-label="Script"]')!.getAttribute("placeholder"),
    ).toContain("uname");
    expect(document.querySelector("#scripts-shell")!.textContent).toContain("Shell (sh)");
    await typeScript("ls");
    await click(button("Clear")!);
    expect(
      (document.querySelector('textarea[aria-label="Script"]') as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("is read-only for viewers and says why", async () => {
    await mount(<ScriptsTab agentId="a1" dashboardRole="viewer" />);
    expect(text()).toContain("Operators only.");
    expect(
      (document.querySelector('textarea[aria-label="Script"]') as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(button("Run script")!.disabled).toBe(true);
  });

  it("tells how to enable scripting when the server has it off", async () => {
    backend.capabilities.mockResolvedValue({ remote_script: false });
    await mount(<ScriptsTab agentId="a1" dashboardRole="admin" />);
    expect(text()).toContain("Remote scripting is off");
    expect(text()).toContain("ALLOW_REMOTE_SCRIPT_EXECUTION=true");
    expect(button("Run script")!.disabled).toBe(true);
  });

  it("shows only the capability notice when the device cannot run scripts", async () => {
    await mount(
      <ScriptsTab
        agentId="a1"
        dashboardRole="admin"
        agentInfo={{ capabilities: { script_execution: "unsupported" } } as never}
      />,
    );
    expect(text()).toContain("Scripts unavailable");
    expect(document.querySelector('textarea[aria-label="Script"]')).toBeNull();
  });
});
