// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, click, fieldErrors, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { InternetScheduleDialog } from "@/features/rules/components/InternetScheduleDialog";
import type { InternetBlockRule } from "@/api/types";

afterEach(unmountForms);

const rule = (patch: Partial<InternetBlockRule> = {}): InternetBlockRule => ({
  id: 7, name: "Kiosks", enabled: true, created_at: "", scopes: [{ kind: "all" }], schedules: [], ...patch,
});

async function open(r: InternetBlockRule, props: { error?: string | null; saving?: boolean } = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  await mountForm(<InternetScheduleDialog rule={r} saving={props.saving ?? false} error={props.error} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose };
}
const toggle = () => document.querySelector<HTMLElement>('[role="checkbox"]')!;
const timeInputs = () => [...document.querySelectorAll<HTMLInputElement>('input[aria-label^="Window"]')];

describe("InternetScheduleDialog", () => {
  it("opens an always-on rule without set hours, and saving keeps it always-on instead of inventing a Monday window", async () => {
    const { onSave } = await open(rule());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(timeInputs()).toHaveLength(0);
    expect(document.body.textContent).toContain("blocks all the time");
    await click(buttonByText("Save schedule"));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), []);
  });

  it("opens a scheduled rule with its hours, an overnight window as one row", async () => {
    const { onSave } = await open(rule({ schedules: [{ day_of_week: 5, start_minute: 22 * 60, end_minute: 1440 }, { day_of_week: 6, start_minute: 0, end_minute: 360 }] }));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(timeInputs().map((i) => i.value)).toEqual(["22:00", "06:00"]);
    expect(document.body.textContent).toContain("Runs overnight, until Saturday 06:00.");
    await click(buttonByText("Save schedule"));
    expect(onSave).toHaveBeenCalledWith(expect.anything(), [
      { day_of_week: 5, start_minute: 1320, end_minute: 1440 },
      { day_of_week: 6, start_minute: 0, end_minute: 360 },
    ]);
  });

  it("turning set hours off stores no windows, so the rule blocks all the time", async () => {
    const { onSave } = await open(rule({ schedules: [{ day_of_week: 1, start_minute: 0, end_minute: 60 }] }));
    await click(toggle());
    await click(buttonByText("Save schedule"));
    expect(onSave).toHaveBeenCalledWith(expect.anything(), []);
  });

  it("says which window is unusable and does not save", async () => {
    const { onSave } = await open(rule({ schedules: [{ day_of_week: 1, start_minute: 0, end_minute: 60 }] }));
    await typeInto(timeInputs()[0], "later");
    await click(buttonByText("Save schedule"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Schedule is enabled but no valid windows were provided (use HH:MM)."]);
  });

  it("tells when the change reaches devices, and that an off rule blocks nothing yet", async () => {
    await open(rule());
    expect(document.body.textContent).toContain("reach connected devices right away");
    unmountForms();
    await open(rule({ enabled: false }));
    expect(document.body.textContent).toContain("This rule is off");
  });

  it("shows why a save failed inside the dialog and locks the form while saving", async () => {
    await open(rule(), { error: "Not found", saving: true });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t save the schedule: Not found");
    expect(buttonByText("Cancel").disabled).toBe(true);
    expect(document.querySelector("fieldset")?.disabled).toBe(true);
  });
});
