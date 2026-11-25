// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { AppBlockRuleDialog } from "@/features/rules/components/AppBlockRuleDialog";

afterEach(unmountForms);

async function open(props: { error?: string | null; saving?: boolean; target?: React.ComponentProps<typeof AppBlockRuleDialog>["target"] } = {}) {
  const onSave = vi.fn();
  await mountForm(
    <AppBlockRuleDialog target={props.target ?? { mode: "create" }} groups={[]} agents={[]} contextAgentId="" saving={props.saving ?? false} error={props.error} onSave={onSave} onClose={vi.fn()} />,
  );
  return onSave;
}

describe("AppBlockRuleDialog", () => {
  it("blocks save and shows 'EXE name is required.' for a blank name", async () => {
    const onSave = await open();
    await typeInto(byLabel("App (EXE name)"), "   ");
    await click(buttonByText("Add rule"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["EXE name is required."]);
  });

  it("saves a trimmed exe name labelled with itself", async () => {
    const onSave = await open();
    await typeInto(byLabel("App (EXE name)"), " tiktok.exe ");
    await click(buttonByText("Add rule"));
    expect(fieldErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledWith(null, expect.objectContaining({ name: "tiktok.exe", exe_pattern: "tiktok.exe", match_mode: "contains", schedules: [] }));
  });

  it("will not save a group scope that names no group, and says so", async () => {
    const onSave = await open({
      target: { mode: "edit", rule: { id: 3, name: "x", exe_pattern: "x.exe", match_mode: "exact", enabled: true, scopes: [{ kind: "group" }], schedules: [] } },
    });
    await click(buttonByText("Save changes"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Each group scope must select a group"]);
  });

  it("names a schedule window that is unusable instead of saving a rule that applies all the time", async () => {
    const onSave = await open();
    await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
    await typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Window 1 end time"]')!, "late");
    await typeInto(byLabel("App (EXE name)"), "tiktok.exe");
    await click(buttonByText("Add rule"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Schedule is enabled but no valid windows were provided (use HH:MM)."]);
  });

  it("says the hours follow each device's clock once set hours are on", async () => {
    await open();
    expect(document.body.textContent).not.toContain("device’s own clock");
    await click(document.querySelector<HTMLElement>('[role="checkbox"]')!);
    expect(document.body.textContent).toContain("Times follow each device’s own clock");
  });

  it("shows a refused save inside the dialog and locks the form while saving", async () => {
    await open({ error: "Name taken", saving: true });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t save the rule: Name taken");
    expect(buttonByText("Cancel").disabled).toBe(true);
    expect(document.querySelector("fieldset")?.disabled).toBe(true);
  });
});
