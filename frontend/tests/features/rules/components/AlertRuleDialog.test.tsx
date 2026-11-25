// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import type { AlertRule } from "@/api/types";
import { AlertRuleDialog } from "@/features/rules/components/AlertRuleDialog";

afterEach(unmountForms);

function open(onSave = vi.fn()) {
  return mountForm(
    <AlertRuleDialog target={{ mode: "create" }} groups={[]} agents={[]} saving={false} onSave={onSave} onClose={vi.fn()} />,
  ).then(() => onSave);
}

const existing: AlertRule = {
  id: 7, name: "Credentials", channel: "keys", pattern: "password", match_mode: "substring", case_insensitive: true,
  cooldown_secs: 900, enabled: false, take_screenshot: true, scopes: [{ kind: "group", group_id: "g1" }],
};

describe("AlertRuleDialog", () => {
  it("blocks save and shows 'Pattern is required' when the pattern is blank", async () => {
    const onSave = await open();
    await click(buttonByText("Create rule"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Pattern is required"]);
  });

  it("saves the trimmed values once a pattern is entered", async () => {
    const onSave = await open();
    await typeInto(byLabel("Name (optional)"), "  Video ");
    await typeInto(byLabel("Pattern"), " youtube.com ");
    await click(buttonByText("Create rule"));
    expect(fieldErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toBeNull();
    expect(onSave.mock.calls[0][1]).toMatchObject({ name: "Video", pattern: "youtube.com", channel: "url", cooldown_secs: 300 });
  });

  it("clamps the cooldown to a non-negative integer", async () => {
    const onSave = await open();
    await typeInto(byLabel("Pattern"), "x");
    await typeInto(byLabel("Cooldown (seconds)"), "-20");
    await click(buttonByText("Create rule"));
    expect(onSave.mock.calls[0][1]).toMatchObject({ cooldown_secs: 0 });
  });

  it("names the save by what it does: Create rule for a new rule, Save changes for an existing one", async () => {
    await mountForm(<AlertRuleDialog target={{ mode: "edit", rule: existing }} groups={[]} agents={[]} saving={false} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(buttonByText("Save changes")).toBeDefined();
    expect(document.querySelector("h2")?.textContent).toBe("Edit alert rule");
  });

  it("sends the edited rule's id and keeps its enabled state", async () => {
    const onSave = vi.fn();
    await mountForm(<AlertRuleDialog target={{ mode: "edit", rule: existing }} groups={[{ id: "g1", name: "Lab" } as never]} agents={[]} saving={false} onSave={onSave} onClose={vi.fn()} />);
    await click(buttonByText("Save changes"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toBe(7);
    expect(onSave.mock.calls[0][1]).toMatchObject({
      name: "Credentials", channel: "keys", pattern: "password", enabled: false, take_screenshot: true, cooldown_secs: 900,
      scopes: [{ kind: "group", group_id: "g1", agent_id: undefined }],
    });
  });

  it("will not save a group or agent scope that names nothing, and says which", async () => {
    const onSave = vi.fn();
    await mountForm(<AlertRuleDialog target={{ mode: "edit", rule: { ...existing, scopes: [{ kind: "group", group_id: "" }] } }} groups={[]} agents={[]} saving={false} onSave={onSave} onClose={vi.fn()} />);
    await click(buttonByText("Save changes"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Each group scope must select a group"]);
  });

  it("shows a failed save inside the dialog", async () => {
    await mountForm(<AlertRuleDialog target={{ mode: "create" }} groups={[]} agents={[]} saving={false} error="invalid regex" onSave={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t save the rule: invalid regex");
  });

  it("cannot be cancelled or re-submitted while the save is running", async () => {
    const onClose = vi.fn();
    await mountForm(<AlertRuleDialog target={{ mode: "create" }} groups={[]} agents={[]} saving onSave={vi.fn()} onClose={onClose} />);
    expect(buttonByText("Cancel").disabled).toBe(true);
    expect(buttonByText("Create rule").disabled).toBe(true);
    expect(document.querySelector("fieldset")?.disabled).toBe(true);
  });

  it("shows only the fields the channel uses", async () => {
    await mountForm(<AlertRuleDialog target={{ mode: "edit", rule: { ...existing, channel: "agent_offline", pattern: "", duration_secs: 600 } }} groups={[]} agents={[]} saving={false} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(byLabel("Offline for (minutes)").value).toBe("10");
    expect(() => byLabel("Pattern")).toThrow();
    expect(document.body.textContent).not.toContain("Take screenshot on trigger");
  });
});
