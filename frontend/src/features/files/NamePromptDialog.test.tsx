import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NamePromptDialog } from "./NamePromptDialog";

let root: Root;
let host: HTMLDivElement;
let setOpen: (open: boolean) => void;
const onSubmit = vi.fn();

function Harness({ initialValue }: { initialValue: string }) {
  const [open, _setOpen] = useState(false);
  setOpen = _setOpen;
  return (
    <NamePromptDialog
      open={open}
      onOpenChange={_setOpen}
      title="Rename"
      label="New name"
      initialValue={initialValue}
      submitLabel="Rename"
      onSubmit={onSubmit}
    />
  );
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onSubmit.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const input = () => document.querySelector<HTMLInputElement>('input[aria-label="New name"]')!;
const submit = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Rename")!;

function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("seeds the value on open, trims it on submit, and closes", async () => {
  await act(async () => root.render(<Harness initialValue="notes.txt" />));
  await act(async () => setOpen(true));
  expect(input().value).toBe("notes.txt");
  type("  report.txt ");
  await act(async () => submit().click());
  expect(onSubmit).toHaveBeenCalledWith("report.txt");
  expect(document.querySelector('input[aria-label="New name"]')).toBeNull();
});

it("disables submit for a blank value and reseeds when reopened", async () => {
  await act(async () => root.render(<Harness initialValue="a.txt" />));
  await act(async () => setOpen(true));
  type("   ");
  expect(submit().disabled).toBe(true);
  await act(async () => setOpen(false));
  await act(async () => setOpen(true));
  expect(input().value).toBe("a.txt");
});
