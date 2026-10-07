// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, byLabel, click, mountForm, typeInto, unmountForms } from "@/test/formDom";
import { NotificationDialog } from "./NotificationDialog";

afterEach(unmountForms);

async function open(onSend: (title: string, message: string) => boolean, canSend = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const onOpenChange = vi.fn();
  await mountForm(
    <NotificationDialog open onOpenChange={onOpenChange} containerRef={{ current: container }} canSend={canSend} onSend={onSend} />,
  );
  return onOpenChange;
}

describe("NotificationDialog", () => {
  it("keeps Send disabled until there is a title", async () => {
    await open(() => true);
    expect(buttonByText("Send").disabled).toBe(true);
    await typeInto(byLabel("Title"), "   ");
    expect(buttonByText("Send").disabled).toBe(true);
    await typeInto(byLabel("Title"), "Hello");
    expect(buttonByText("Send").disabled).toBe(false);
  });

  it("stays disabled when the device cannot receive notifications", async () => {
    await open(() => true, false);
    await typeInto(byLabel("Title"), "Hello");
    expect(buttonByText("Send").disabled).toBe(true);
  });

  it("sends the title and message as typed and closes when it was sent", async () => {
    const onSend = vi.fn(() => true);
    const onOpenChange = await open(onSend);
    await typeInto(byLabel("Title"), " Hello ");
    await typeInto(byLabel("Message"), "Lunch time");
    await click(buttonByText("Send"));
    expect(onSend).toHaveBeenCalledWith(" Hello ", "Lunch time");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open when sending failed", async () => {
    const onOpenChange = await open(() => false);
    await typeInto(byLabel("Title"), "Hello");
    await click(buttonByText("Send"));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
