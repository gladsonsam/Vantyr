// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { AppBlockRuleDialog } from "@/features/rules/components/AppBlockRuleDialog";

afterEach(unmountForms);

async function open() {
  const onSave = vi.fn();
  await mountForm(
    <AppBlockRuleDialog target={{ mode: "create" }} groups={[]} agents={[]} contextAgentId="" saving={false} onSave={onSave} onClose={vi.fn()} />,
  );
  return onSave;
}

describe("AppBlockRuleDialog", () => {
  it("blocks save and shows 'EXE name is required.' for a blank name", async () => {
    const onSave = await open();
    await typeInto(byLabel("EXE name"), "   ");
    await click(buttonByText("Add rule"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["EXE name is required."]);
  });

  it("saves a trimmed exe name labelled with itself", async () => {
    const onSave = await open();
    await typeInto(byLabel("EXE name"), " tiktok.exe ");
    await click(buttonByText("Add rule"));
    expect(fieldErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledWith(null, expect.objectContaining({ name: "tiktok.exe", exe_pattern: "tiktok.exe", match_mode: "contains", schedules: [] }));
  });
});
