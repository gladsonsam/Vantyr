// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@/test/formDom";
import { GroupModal } from "./GroupModal";
import { RuleModal } from "./RuleModal";

afterEach(unmountForms);

describe("GroupModal", () => {
  it("keeps Save disabled for a blank name and saves trimmed values", async () => {
    const onSave = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(<GroupModal visible onDismiss={onDismiss} group={null} onSave={onSave} />);
    expect(buttonByText("Save").disabled).toBe(true);
    await typeInto(byLabel("Name"), "   ");
    expect(buttonByText("Save").disabled).toBe(true);
    await typeInto(byLabel("Name"), " Lab ");
    await typeInto(byLabel("Description"), " 2nd floor ");
    await click(buttonByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ name: "Lab", description: "2nd floor" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("RuleModal", () => {
  const props = { visible: true, rule: null, agentOptions: [], groupOptions: [{ label: "Lab", value: "g1" }] };

  it("keeps Save disabled until a pattern is typed", async () => {
    await mountForm(<RuleModal {...props} onDismiss={vi.fn()} onSave={vi.fn(async () => {})} />);
    expect(buttonByText("Save").disabled).toBe(true);
    await typeInto(byLabel("Pattern"), "youtube.com");
    expect(buttonByText("Save").disabled).toBe(false);
  });

  it("saves the trimmed pattern with the default scope and cooldown", async () => {
    const onSave = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await mountForm(<RuleModal {...props} onDismiss={onDismiss} onSave={onSave} />);
    await typeInto(byLabel("Pattern"), " youtube.com ");
    await click(buttonByText("Save"));
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
    await click(buttonByText("Save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Each group scope must select a group"]);
  });
});
