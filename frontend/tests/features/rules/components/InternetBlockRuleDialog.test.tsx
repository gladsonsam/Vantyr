// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, click, fieldErrors, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { InternetBlockRuleDialog } from "@/features/rules/components/InternetBlockRuleDialog";

afterEach(unmountForms);

async function open() {
  const onSave = vi.fn();
  await mountForm(<InternetBlockRuleDialog open groups={[]} agents={[]} saving={false} onSave={onSave} onClose={vi.fn()} />);
  return onSave;
}

const scheduleCheckbox = () => document.querySelector<HTMLElement>('[role="checkbox"]')!;

describe("InternetBlockRuleDialog", () => {
  it("creates an unscheduled rule without validation errors", async () => {
    const onSave = await open();
    await click(buttonByText("Create"));
    expect(fieldErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "", schedules: undefined }));
  });

  it("rejects an enabled schedule whose windows are all unusable", async () => {
    const onSave = await open();
    await click(scheduleCheckbox());
    await typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Window 1 start time"]')!, "bad");
    await click(buttonByText("Create"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Schedule is enabled but no valid windows were provided (use HH:MM)."]);
  });

  it("sends the expanded windows once a valid time is typed", async () => {
    const onSave = await open();
    await click(scheduleCheckbox());
    await click(buttonByText("Create"));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ schedules: [{ day_of_week: 1, start_minute: 0, end_minute: 1439 }] }));
  });
});
