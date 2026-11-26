import { testMock as vi } from "@tests/support/mock";
import { afterEach, describe, expect, it } from "bun:test";
import {
  buttonByText,
  click,
  fieldErrors,
  mountForm,
  typeInto,
  unmountForms,
} from "@tests/support/formDom";
import { InternetBlockRuleDialog } from "@/features/rules/components/InternetBlockRuleDialog";

afterEach(unmountForms);

async function open(props: { error?: string | null; saving?: boolean } = {}) {
  const onSave = vi.fn();
  await mountForm(
    <InternetBlockRuleDialog
      open
      groups={[]}
      agents={[]}
      saving={props.saving ?? false}
      error={props.error}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  return onSave;
}

const scheduleCheckbox = () => document.querySelector<HTMLElement>('[role="checkbox"]')!;

describe("InternetBlockRuleDialog", () => {
  it("creates an unscheduled rule without validation errors", async () => {
    const onSave = await open();
    await click(buttonByText("Create rule"));
    expect(fieldErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "", schedules: undefined }),
    );
  });

  it("rejects an enabled schedule whose windows are all unusable", async () => {
    const onSave = await open();
    await click(scheduleCheckbox());
    await typeInto(
      document.querySelector<HTMLInputElement>('input[aria-label="Window 1 start time"]')!,
      "bad",
    );
    await click(buttonByText("Create rule"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual([
      "Schedule is enabled but no valid windows were provided (use HH:MM).",
    ]);
  });

  it("sends the expanded windows once a valid time is typed", async () => {
    const onSave = await open();
    await click(scheduleCheckbox());
    await click(buttonByText("Create rule"));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        schedules: [{ day_of_week: 1, start_minute: 0, end_minute: 1439 }],
      }),
    );
  });

  it("says what the rule does to devices and when, before it is created", async () => {
    await open();
    expect(document.body.textContent).toContain("connected devices lose internet right away");
    await click(scheduleCheckbox());
    expect(document.body.textContent).toContain("lose internet only during these hours");
    expect(document.body.textContent).toContain("Times follow each device’s own clock");
  });

  it("shows a refused create inside the dialog and locks the form while saving", async () => {
    await open({ error: "Forbidden", saving: true });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn’t create the rule: Forbidden",
    );
    expect(buttonByText("Cancel").disabled).toBe(true);
  });
});
