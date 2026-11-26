import { testMock as vi } from "@tests/support/mock";
import { afterEach, describe, expect, it } from "bun:test";
import { buttonByText, click, mountForm, unmountForms } from "@tests/support/formDom";
import {
  PendingApprovalsCard,
  type PendingAgentClaim,
} from "@/features/enrollment/PendingApprovalsCard";

const claim = (over: Partial<PendingAgentClaim>): PendingAgentClaim => ({
  id: "c1",
  status: "pending",
  requested_name: "FRONT-DESK",
  hostname: "front-desk.lan",
  client_ip: "10.0.0.8",
  agent_version: "0.2.9",
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});
const text = () => document.body.textContent ?? "";
const byAria = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

afterEach(unmountForms);

describe("PendingApprovalsCard", () => {
  it("renders nothing when no device is waiting", async () => {
    await mountForm(
      <PendingApprovalsCard
        claims={[claim({ status: "approved" })]}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(document.body.textContent).toBe("");
  });

  it("names the device on each action so several waiting devices can be told apart", async () => {
    await mountForm(
      <PendingApprovalsCard
        claims={[claim({}), claim({ id: "c2", requested_name: "KITCHEN" })]}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(text()).toContain("Pending approval");
    expect(byAria("Approve FRONT-DESK")).not.toBeNull();
    expect(byAria("Reject KITCHEN")).not.toBeNull();
  });

  it("approves under the typed name after showing what is being approved", async () => {
    const onApprove = vi.fn();
    await mountForm(
      <PendingApprovalsCard claims={[claim({})]} onApprove={onApprove} onReject={vi.fn()} />,
    );
    expect(text()).toContain("Wants to join");
    await click(byAria("Approve FRONT-DESK"));
    expect(text()).toContain(
      "Check that the host and address below are the device you are setting up.",
    );
    expect(text()).toContain("10.0.0.8");
    await click(buttonByText("Approve device"));
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), "FRONT-DESK");
  });

  it("keeps the dialog open and shows the reason when a rejection fails", async () => {
    const onReject = vi.fn().mockRejectedValue(new Error("already gone"));
    await mountForm(
      <PendingApprovalsCard claims={[claim({})]} onApprove={vi.fn()} onReject={onReject} />,
    );
    await click(byAria("Reject FRONT-DESK"));
    expect(text()).toContain("front-desk.lan · 10.0.0.8");
    expect(text()).toContain("The agent will need to request access again before it can connect.");
    const rejects = [...document.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Reject",
    );
    await click(rejects[rejects.length - 1]);
    expect(onReject).toHaveBeenCalled();
    expect(text()).toContain("already gone");
    expect(text()).toContain("Reject FRONT-DESK?");
  });
});
