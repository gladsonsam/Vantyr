import {
  buttonByText,
  byLabel,
  click,
  fieldErrors,
  mountForm,
  typeInto,
  unmountForms,
} from "@tests/support/formDom";
import { withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { afterEach, describe, expect, it } from "bun:test";

const api = (() => ({
  capabilities: vi.fn(async () => ({ scheduler_timezone: "Australia/Perth" })),
}))();
await vi.mock("@/api", () => ({ api }));

const { ScheduledScriptDialog } = await import("@/features/rules/components/ScheduledScriptDialog");

afterEach(unmountForms);

async function open(props: { error?: string | null; saving?: boolean } = {}) {
  const onSave = vi.fn();
  await mountForm(
    withQueryClient(
      <ScheduledScriptDialog
        target={{ mode: "create" }}
        groups={[]}
        agents={[]}
        saving={props.saving ?? false}
        error={props.error}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    ),
  );
  return onSave;
}
async function fillRequired() {
  await typeInto(byLabel("Script name"), "Health");
  await typeInto(document.getElementById("script-code") as HTMLTextAreaElement, "dir");
}

describe("ScheduledScriptDialog", () => {
  it("shows both required-field messages on their own fields and blocks save", async () => {
    const onSave = await open();
    await click(buttonByText("Create script"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Name is required", "Script is required"]);
  });

  it("saves the script untrimmed with a trimmed name and default timeout", async () => {
    const onSave = await open();
    await typeInto(byLabel("Script name"), " Health ");
    await typeInto(document.getElementById("script-code") as HTMLTextAreaElement, "dir\n");
    await click(buttonByText("Create script"));
    expect(fieldErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        name: "Health",
        script: "dir\n",
        shell: "powershell",
        timeout_secs: 120,
        schedules: [{ frequency: "daily", fire_minute: 0, day_of_week: undefined }],
      }),
    );
  });

  it("says which clock the times follow", async () => {
    await open();
    await act(async () => {});
    expect(document.body.textContent).toContain(
      "Times follow the server’s timezone (Australia/Perth), not each device’s clock.",
    );
  });

  it("keeps the timeout within what the server accepts", async () => {
    const onSave = await open();
    await fillRequired();
    await typeInto(byLabel("Timeout in seconds (5 to 300)"), "900");
    await click(buttonByText("Create script"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Timeout must be 5 to 300 seconds."]);
  });

  it("names a schedule time that can't be read instead of firing at midnight", async () => {
    const onSave = await open();
    await fillRequired();
    await typeInto(
      document.querySelector<HTMLInputElement>('input[aria-label="Schedule 1 time"]')!,
      "teatime",
    );
    await click(buttonByText("Create script"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Schedule 1: enter a time as HH:MM."]);
  });

  it("adds and removes schedules, but keeps at least one", async () => {
    await open();
    const rows = () => document.querySelectorAll('input[aria-label^="Schedule "]').length;
    expect(rows()).toBe(1);
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Remove schedule 1"]')!.disabled,
    ).toBe(true);
    await click(buttonByText("Add schedule"));
    expect(rows()).toBe(2);
    await click(document.querySelector('button[aria-label="Remove schedule 2"]')!);
    expect(rows()).toBe(1);
  });

  it("sends two schedules once both are filled in", async () => {
    const onSave = await open();
    await fillRequired();
    await click(buttonByText("Add schedule"));
    await typeInto(
      document.querySelector<HTMLInputElement>('input[aria-label="Schedule 2 time"]')!,
      "13:30",
    );
    await click(buttonByText("Create script"));
    expect(onSave).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        schedules: [
          { frequency: "daily", fire_minute: 0, day_of_week: undefined },
          { frequency: "daily", fire_minute: 810, day_of_week: undefined },
        ],
      }),
    );
  });

  it("shows a refused save inside the dialog and locks the form while saving", async () => {
    await open({ error: "timeout_secs must be between 5 and 300", saving: true });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn’t save the script: timeout_secs must be between 5 and 300",
    );
    expect(buttonByText("Cancel").disabled).toBe(true);
    expect(document.querySelector("fieldset")?.disabled).toBe(true);
  });
});
