// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { GroupModal } from "@/features/groups/GroupModal";
import { RuleModal } from "@/features/groups/RuleModal";

afterEach(unmountForms);

describe("GroupModal", () => {
  const existing = { id: "g1", name: "Lab", description: "2nd floor", created_at: "2026-10-01T00:00:00Z", member_count: 2 };

  it("keeps Create group disabled for a blank name and saves trimmed values", async () => {
    const onSave = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(<GroupModal visible onDismiss={onDismiss} group={null} onSave={onSave} />);
    expect(document.querySelector("h2")?.textContent).toBe("Create group");
    expect(buttonByText("Create group").disabled).toBe(true);
    await typeInto(byLabel("Name"), "   ");
    expect(buttonByText("Create group").disabled).toBe(true);
    expect(fieldErrors()).toEqual(["Name is required."]);
    await typeInto(byLabel("Name"), " Lab ");
    await typeInto(byLabel("Description"), " 2nd floor ");
    await click(buttonByText("Create group"));
    expect(onSave).toHaveBeenCalledWith({ name: "Lab", description: "2nd floor" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("edits an existing group, prefilled, and cancels without saving", async () => {
    const onSave = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(<GroupModal visible onDismiss={onDismiss} group={existing} onSave={onSave} />);
    expect(document.querySelector("h2")?.textContent).toBe("Edit group");
    expect(byLabel("Name").value).toBe("Lab");
    expect(byLabel("Description").value).toBe("2nd floor");
    await click(buttonByText("Cancel"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays open with the failure in the dialog and saves on the next try", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("A group with that name exists")).mockResolvedValue(undefined);
    const onDismiss = vi.fn();
    await mountForm(<GroupModal visible onDismiss={onDismiss} group={existing} onSave={onSave} />);
    await click(buttonByText("Save changes"));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("A group with that name exists");
    expect(buttonByText("Save changes").disabled).toBe(false);
    await click(buttonByText("Save changes"));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("RuleModal", () => {
  const props = { visible: true, rule: null, agentOptions: [], groupOptions: [{ label: "Lab", value: "g1" }] };

  it("keeps Save disabled until a pattern is typed", async () => {
    await mountForm(<RuleModal {...props} onDismiss={vi.fn()} onSave={vi.fn(async () => {})} />);
    expect(buttonByText("Create rule").disabled).toBe(true);
    await typeInto(byLabel("Pattern"), "youtube.com");
    expect(buttonByText("Create rule").disabled).toBe(false);
  });

  it("saves the trimmed pattern with the default scope and cooldown", async () => {
    const onSave = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(<RuleModal {...props} onDismiss={onDismiss} onSave={onSave} />);
    await typeInto(byLabel("Pattern"), " youtube.com ");
    await click(buttonByText("Create rule"));
    expect(onSave).toHaveBeenCalledWith({
      name: "", channel: "url", pattern: "youtube.com", match_mode: "substring", case_insensitive: true,
      cooldown_secs: 300, enabled: true, take_screenshot: false, scopes: [{ kind: "all", group_id: "", agent_id: "" }],
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays open and shows the message when a group scope has no group", async () => {
    const onSave = vi.fn(async () => {});
    const onDismiss = vi.fn();
    const rule = {
      id: 0, name: "", channel: "url" as const, pattern: "x", match_mode: "substring" as const, case_insensitive: true,
      cooldown_secs: 300, enabled: true, take_screenshot: false, scopes: [{ kind: "group" as const, group_id: "", agent_id: "" }],
    };
    await mountForm(<RuleModal {...props} rule={rule} onDismiss={onDismiss} onSave={onSave} />);
    await click(buttonByText("Create rule"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Each group scope must select a group"]);
  });

  it("stays open with the failure inside the dialog when the save is refused, then saves on retry", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("invalid regex")).mockResolvedValue(undefined);
    const onDismiss = vi.fn();
    await mountForm(<RuleModal {...props} onDismiss={onDismiss} onSave={onSave} />);
    await typeInto(byLabel("Pattern"), "x");
    await click(buttonByText("Create rule"));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t save the rule: invalid regex");
    expect(buttonByText("Create rule").disabled).toBe(false);
    await click(buttonByText("Create rule"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("titles a new rule as new, takes a heading, and an existing rule as an edit", async () => {
    const draft = {
      id: 0, name: "", channel: "url" as const, pattern: "", match_mode: "substring" as const, case_insensitive: true,
      cooldown_secs: 300, enabled: true, take_screenshot: false, scopes: [{ kind: "group" as const, group_id: "g1", agent_id: "" }],
    };
    await mountForm(<RuleModal {...props} rule={draft} heading="New alert rule for Lab" onDismiss={vi.fn()} onSave={vi.fn(async () => {})} />);
    expect(document.querySelector("h2")?.textContent).toBe("New alert rule for Lab");
    unmountForms();
    await mountForm(<RuleModal {...props} rule={{ ...draft, id: 5, pattern: "x" }} onDismiss={vi.fn()} onSave={vi.fn(async () => {})} />);
    expect(document.querySelector("h2")?.textContent).toBe("Edit alert rule");
    expect(buttonByText("Save changes")).toBeDefined();
  });
});
