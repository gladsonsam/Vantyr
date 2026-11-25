// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { buttonByText, click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { MembersModal } from "@/features/groups/MembersModal";
import type { Agent } from "@/api/types";

afterEach(unmountForms);

const agent = (id: string, name: string) => ({ id, name }) as Agent;
const group = { id: "g1", name: "Lab", description: "Teaching PCs", created_at: "2026-10-01T00:00:00Z", member_count: 2 };
const devices = [agent("a1", "Alpha"), agent("a2", "Bravo"), agent("a3", "Charlie"), agent("a4", "Delta")];

function renderModal(overrides: Partial<Parameters<typeof MembersModal>[0]> = {}) {
  const props = {
    visible: true,
    onDismiss: vi.fn(),
    group,
    memberIds: ["a1", "a2"] as string[] | null,
    agentsList: devices,
    onAddMembers: vi.fn(async () => {}),
    onRemoveMember: vi.fn(async () => {}),
    ...overrides,
  };
  return { props, mounted: mountForm(<MembersModal {...props} />) };
}

const tab = (label: RegExp) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => label.test(t.textContent ?? ""))!;
const names = (list: string) => [...document.querySelectorAll(`ul[aria-label="${list}"] li`)].map((li) => li.querySelector("p")?.textContent);
const checkbox = (label: string) => document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${label}"]`)!;
const status = () => document.querySelector('[role="status"]');

describe("MembersModal", () => {
  it("opens on the current members with counts on both tabs and the group description", async () => {
    await renderModal().mounted;
    expect(document.body.textContent).toContain("Teaching PCs");
    expect(tab(/In group/).textContent).toBe("In group (2)");
    expect(tab(/Add devices/).textContent).toBe("Add devices (2)");
    expect(tab(/In group/).getAttribute("aria-selected")).toBe("true");
    expect(names("Devices in this group")).toEqual(["Alpha", "Bravo"]);
  });

  it("opens on Add devices when the group is empty and says what is available", async () => {
    await renderModal({ memberIds: [] }).mounted;
    expect(tab(/Add devices/).getAttribute("aria-selected")).toBe("true");
    expect(names("Devices you can add")).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  it("shows a loading state until the members arrive", async () => {
    await renderModal({ memberIds: null }).mounted;
    expect(document.body.textContent).toContain("Loading members…");
    expect(document.querySelector('[role="tablist"]')).toBeNull();
  });

  it("stages a selection as not added yet, and only a confirm sends it", async () => {
    const { props, mounted } = renderModal();
    await mounted;
    await click(tab(/Add devices/));
    expect(names("Devices you can add")).toEqual(["Charlie", "Delta"]);
    expect(document.body.textContent).not.toContain("not added yet");
    await click(checkbox("Add Charlie"));
    expect(document.body.textContent).toContain("1 selected · not added yet");
    expect(props.onAddMembers).not.toHaveBeenCalled();
    await click(checkbox("Add Delta"));
    await click(buttonByText("Add 2 devices"));
    expect(props.onAddMembers).toHaveBeenCalledWith(["a3", "a4"]);
    expect(status()?.textContent).toBe("Added 2 devices to Lab.");
    expect(document.activeElement).toBe(status());
    expect(document.body.textContent).not.toContain("not added yet");
  });

  it("deselects one device, selects and clears all shown, and discards on close", async () => {
    const { props, mounted } = renderModal();
    await mounted;
    await click(tab(/Add devices/));
    await click(checkbox("Select all devices"));
    expect(document.body.textContent).toContain("2 selected");
    await click(checkbox("Add Charlie"));
    expect(document.body.textContent).toContain("1 selected");
    await click(buttonByText("Clear"));
    expect(document.body.textContent).not.toContain("selected ·");
    await click(checkbox("Add Delta"));
    await click(buttonByText("Discard"));
    expect(props.onDismiss).toHaveBeenCalled();
    expect(props.onAddMembers).not.toHaveBeenCalled();
  });

  it("removes a member, reports it and moves focus to the outcome", async () => {
    const { props, mounted } = renderModal();
    await mounted;
    await click(document.querySelector<HTMLElement>('button[aria-label="Remove Alpha from group"]')!);
    expect(props.onRemoveMember).toHaveBeenCalledWith("a1");
    expect(status()?.textContent).toBe("Removed Alpha from Lab.");
    expect(document.activeElement).toBe(status());
  });

  it("keeps the selection and shows the failure in the dialog when adding fails, then recovers", async () => {
    const onAddMembers = vi.fn().mockRejectedValueOnce(new Error("Server unavailable")).mockResolvedValue(undefined);
    await renderModal({ onAddMembers }).mounted;
    await click(tab(/Add devices/));
    await click(checkbox("Add Charlie"));
    await click(buttonByText("Add 1 device"));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Server unavailable");
    expect(document.body.textContent).toContain("1 selected · not added yet");
    expect(status()).toBeNull();
    await click(buttonByText("Add 1 device"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(status()?.textContent).toBe("Added 1 device to Lab.");
  });

  it("shows a failed removal and leaves the member in place", async () => {
    const onRemoveMember = vi.fn().mockRejectedValue(new Error("Forbidden"));
    await renderModal({ onRemoveMember }).mounted;
    await click(document.querySelector<HTMLElement>('button[aria-label="Remove Bravo from group"]')!);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Forbidden");
    expect(names("Devices in this group")).toEqual(["Alpha", "Bravo"]);
  });

  it("offers retry for a failed member load", async () => {
    const onRetry = vi.fn();
    await renderModal({ memberIds: null, loadError: "Couldn’t load members: offline", onRetry }).mounted;
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("offline");
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector('ul[aria-label="Devices you can add"]')).toBeNull();
    await click(buttonByText("Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("searches long lists, explains an empty result and clears the search", async () => {
    const many = Array.from({ length: 8 }, (_, i) => agent(`m${i}`, `Machine ${i}`));
    await renderModal({ memberIds: many.map((m) => m.id), agentsList: many }).mounted;
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search devices"]')!;
    expect(search).not.toBeNull();
    await typeInto(search, "machine 3");
    expect(names("Devices in this group")).toEqual(["Machine 3"]);
    await typeInto(search, "zzz");
    expect(document.body.textContent).toContain("No members match “zzz”.");
    await click(buttonByText("Clear search"));
    expect(names("Devices in this group")).toHaveLength(8);
  });

  it("hides the search box for a short list", async () => {
    await renderModal().mounted;
    expect(document.querySelector('input[aria-label="Search devices"]')).toBeNull();
  });

  it("tells same-named devices apart and keeps unknown members removable", async () => {
    const twins = [agent("11111111-aaaa", "Desk"), agent("22222222-bbbb", "Desk")];
    await renderModal({ memberIds: ["11111111-aaaa", "gone-id-0001"], agentsList: twins }).mounted;
    const text = document.body.textContent ?? "";
    expect(text).toContain("11111111…");
    expect(text).toContain("Unknown device");
    expect(document.querySelector('button[aria-label="Remove gone-id-0001 from group"]')).not.toBeNull();
  });

  it("renders nothing while closed", async () => {
    await renderModal({ visible: false }).mounted;
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {});
  });
});
