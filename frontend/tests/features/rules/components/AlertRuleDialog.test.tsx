// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { AlertRuleDialog } from "@/features/rules/components/AlertRuleDialog";

afterEach(unmountForms);

function open(onSave = vi.fn()) {
  return mountForm(
    <AlertRuleDialog target={{ mode: "create" }} groups={[]} agents={[]} saving={false} onSave={onSave} onClose={vi.fn()} />,
  ).then(() => onSave);
}

describe("AlertRuleDialog", () => {
  it("blocks save and shows 'Pattern is required' when the pattern is blank", async () => {
    const onSave = await open();
    await click(buttonByText("Save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Pattern is required"]);
  });

  it("saves the trimmed values once a pattern is entered", async () => {
    const onSave = await open();
    await typeInto(byLabel("Name (optional)"), "  Video ");
    await typeInto(byLabel("Pattern"), " youtube.com ");
    await click(buttonByText("Save"));
    expect(fieldErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toBeNull();
    expect(onSave.mock.calls[0][1]).toMatchObject({ name: "Video", pattern: "youtube.com", channel: "url", cooldown_secs: 300 });
  });

  it("clamps the cooldown to a non-negative integer", async () => {
    const onSave = await open();
    await typeInto(byLabel("Pattern"), "x");
    await typeInto(byLabel("Cooldown (seconds)"), "-20");
    await click(buttonByText("Save"));
    expect(onSave.mock.calls[0][1]).toMatchObject({ cooldown_secs: 0 });
  });
});
