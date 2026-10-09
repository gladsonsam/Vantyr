// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { withQueryClient } from "@tests/support/queryClient";
import { buttonByText, byLabel, click, fieldErrors, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { ScheduledScriptDialog } from "@/features/rules/components/ScheduledScriptDialog";

const api = vi.hoisted(() => ({ capabilities: vi.fn(async () => ({ scheduler_timezone: "UTC" })) }));
vi.mock("@/api", () => ({ api }));

afterEach(unmountForms);

async function open() {
  const onSave = vi.fn();
  await mountForm(withQueryClient(
    <ScheduledScriptDialog target={{ mode: "create" }} groups={[]} agents={[]} saving={false} onSave={onSave} onClose={vi.fn()} />,
  ));
  return onSave;
}

describe("ScheduledScriptDialog", () => {
  it("shows both required-field messages on their own fields and blocks save", async () => {
    const onSave = await open();
    await click(buttonByText("Save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(fieldErrors()).toEqual(["Name is required", "Script is required"]);
  });

  it("saves the script untrimmed with a trimmed name and default timeout", async () => {
    const onSave = await open();
    await typeInto(byLabel("Script name"), " Health ");
    await typeInto(document.getElementById("script-code") as HTMLTextAreaElement, "dir\n");
    await click(buttonByText("Save"));
    expect(fieldErrors()).toEqual([]);
    expect(onSave).toHaveBeenCalledWith(null, expect.objectContaining({
      name: "Health", script: "dir\n", shell: "powershell", timeout_secs: 120,
      schedules: [{ frequency: "daily", fire_minute: 0, day_of_week: undefined }],
    }));
  });
});
