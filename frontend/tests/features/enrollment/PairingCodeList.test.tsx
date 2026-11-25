// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonByText, click, mountForm, unmountForms } from "@tests/support/formDom";
import { PairingCodeList, type EnrollmentToken } from "@/features/enrollment/PairingCodeList";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const hours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const token = (over: Partial<EnrollmentToken>): EnrollmentToken => ({
  id: "t1", uses_remaining: 1, created_at: hours(-1), expires_at: hours(3), note: "Front desk", used_count: 0, last_used_at: null, ...over,
});

const onRefresh = vi.fn(async () => {});
const onRevoke = vi.fn(async () => {});
const onRevokeAll = vi.fn(async () => {});
const onListUses = vi.fn(async () => [{ used_at: hours(-0.5), agent_name: "LAPTOP-7", agent_id: "agent-123" }]);
const onClearError = vi.fn();

function render(tokens: EnrollmentToken[], props: Partial<Parameters<typeof PairingCodeList>[0]> = {}) {
  return mountForm(
    <PairingCodeList tokens={tokens} loading={false} error={null} listedAt={NOW} onRefresh={onRefresh} onRevoke={onRevoke}
      onRevokeAll={onRevokeAll} onListUses={onListUses} onClearError={onClearError} {...props} />,
  );
}
const text = () => document.body.textContent ?? "";
const byAria = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => vi.clearAllMocks());
afterEach(unmountForms);

describe("PairingCodeList", () => {
  it("says where each code stands: usable, expired, used up and revoked", async () => {
    await render([
      token({ id: "a", note: "Front desk", uses_remaining: 2 }),
      token({ id: "b", note: "Old code", expires_at: hours(-2) }),
      token({ id: "c", note: "Spent", uses_remaining: 0, used_count: 1, last_used_at: hours(-1) }),
      token({ id: "d", note: "Pulled", uses_remaining: 0 }),
      token({ id: "e", note: "Open ended", expires_at: null }),
    ]);
    expect(text()).toContain("2 uses left");
    expect(text()).toContain("expires in 3h");
    expect(text()).toContain("Expired");
    expect(text()).toContain("Used up");
    expect(text()).toContain("used 1×, last 1h ago");
    expect(text()).toContain("Revoked or used up");
    expect(text()).toContain("no expiry");
    expect(text()).toContain("created 1h ago");
  });

  it("gives Revoke only to codes with uses left, each named for its code", async () => {
    await render([token({ id: "a" }), token({ id: "c", note: "Spent", uses_remaining: 0, used_count: 1 })]);
    expect(byAria("Revoke Front desk")).not.toBeNull();
    expect(byAria("Revoke Spent")).toBeNull();
  });

  it("says the load failed instead of 'No pairing codes yet'", async () => {
    await render([], { error: "boom" });
    expect(text()).toContain("boom");
    expect(text()).not.toContain("No pairing codes yet");
    await click(buttonByText("Try again"));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("points an empty list at generating a code", async () => {
    await render([]);
    expect(text()).toContain("No pairing codes yet. Generate one above to enroll a device.");
  });

  it("shows who used a code and lets the list be hidden again", async () => {
    await render([token({ used_count: 1, last_used_at: hours(-0.5) })]);
    await click(byAria("Show devices that used Front desk"));
    expect(onListUses).toHaveBeenCalledWith("t1");
    expect(text()).toContain("LAPTOP-7");
    expect(text()).toContain("agent-123");
    const toggle = byAria("Hide devices that used Front desk");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await click(toggle);
    expect(text()).not.toContain("LAPTOP-7");
  });

  it("offers Try again when the uses could not be loaded", async () => {
    onListUses.mockRejectedValueOnce(new Error("nope"));
    await render([token({ used_count: 1 })]);
    await click(byAria("Show devices that used Front desk"));
    expect(text()).toContain("Couldn't load the uses. nope");
    await click(buttonByText("Try again"));
    expect(text()).toContain("LAPTOP-7");
  });

  it("says what revoking does before revoking one code", async () => {
    await render([token({})]);
    await click(byAria("Revoke Front desk"));
    expect(text()).toContain("Revoke “Front desk”?");
    expect(text()).toContain("Devices that already joined with it stay connected.");
    expect(onRevoke).not.toHaveBeenCalled();
    await click(buttonByText("Revoke code"));
    expect(onRevoke).toHaveBeenCalledWith("t1");
    expect(onRefresh).toHaveBeenCalled();
  });

  it("keeps the dialog open and says so when a revoke is refused", async () => {
    onRevoke.mockRejectedValueOnce(new Error("forbidden"));
    await render([token({})]);
    await click(byAria("Revoke Front desk"));
    await click(buttonByText("Revoke code"));
    expect(text()).toContain("Not revoked. forbidden");
    expect(text()).toContain("Revoke “Front desk”?");
  });

  it("counts the codes Revoke all would stop", async () => {
    await render([token({ id: "a" }), token({ id: "b", uses_remaining: 3 }), token({ id: "c", uses_remaining: 0 })]);
    await click(buttonByText("Revoke all"));
    expect(text()).toContain("Revoke 2 pairing codes?");
    await click(buttonByText("Cancel"));
    expect(onRevokeAll).not.toHaveBeenCalled();
  });

  it("hides Revoke all when nothing can be revoked", async () => {
    await render([token({ uses_remaining: 0, used_count: 1 })]);
    expect([...document.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain("Revoke all");
  });
});
