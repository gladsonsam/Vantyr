// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckboxField, InputField, NumberField } from "@/components/common/form/fields";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  size: z.number().min(1, "Size must be at least 1"),
  on: z.boolean(),
});
type Values = z.infer<typeof schema>;

function Demo({ onSubmit }: { onSubmit: (values: Values) => void }) {
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: "", size: 3, on: false } });
  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <InputField control={form.control} name="name" label="Name" />
      <NumberField control={form.control} name="size" label="Size" parse={(raw) => parseInt(raw, 10) || 0} />
      <CheckboxField control={form.control} name="on" label="Turn on" />
      <button type="submit">Save</button>
    </form>
  );
}

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

async function mount(onSubmit: (values: Values) => void) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<Demo onSubmit={onSubmit} />));
  return host;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(host: HTMLElement) {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("form fields", () => {
  it("shows the schema message under an invalid field and blocks submit", async () => {
    const onSubmit = vi.fn();
    const host = await mount(onSubmit);
    await submit(host);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.querySelector('[data-slot="field-error"]')?.textContent).toBe("Name is required");
    expect(host.querySelector("input")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("submits parsed values once the form is valid", async () => {
    const onSubmit = vi.fn();
    const host = await mount(onSubmit);
    const [name, size] = Array.from(host.querySelectorAll("input"));
    await type(name, "  Ada ");
    await type(size, "7");
    await submit(host);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual({ name: "Ada", size: 7, on: false });
    expect(host.querySelector('[data-slot="field-error"]')).toBeNull();
  });

  it("clears a numeric field to the parsed fallback instead of NaN", async () => {
    const onSubmit = vi.fn();
    const host = await mount(onSubmit);
    const [name, size] = Array.from(host.querySelectorAll("input"));
    await type(name, "x");
    await type(size, "");
    await submit(host);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.querySelector('[data-slot="field-error"]')?.textContent).toBe("Size must be at least 1");
  });
});
