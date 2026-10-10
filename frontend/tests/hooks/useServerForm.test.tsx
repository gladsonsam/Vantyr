// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { useServerForm } from "@/hooks/useServerForm";

const schema = z.object({ name: z.string() });
type Values = z.infer<typeof schema>;

const roots: Root[] = [];
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); });

async function setup(initial: { data?: { name: string }; version: number }) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let form!: UseFormReturn<Values>;
  function Probe({ data, version }: { data?: { name: string }; version: number }) {
    form = useServerForm<Values, { name: string }>({
      resolver: zodResolver(schema), data, version, toValues: (d) => ({ name: d.name }), initial: { name: "" },
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  const render = (props: { data?: { name: string }; version: number }) => act(async () => root.render(<Probe {...props} />));
  await render(initial);
  return { render, get form() { return form; } };
}

describe("useServerForm", () => {
  it("starts from the initial values until data arrives, then seeds from it", async () => {
    const t = await setup({ version: 0 });
    expect(t.form.getValues()).toEqual({ name: "" });
    await t.render({ data: { name: "Ada" }, version: 1 });
    expect(t.form.getValues()).toEqual({ name: "Ada" });
  });

  it("keeps edits across renders of the same server version and overwrites them on a newer one", async () => {
    const data = { name: "Ada" };
    const t = await setup({ data, version: 1 });
    await act(async () => t.form.setValue("name", "Edited"));
    await t.render({ data, version: 1 });
    expect(t.form.getValues("name")).toBe("Edited");
    await t.render({ data: { name: "Server" }, version: 2 });
    expect(t.form.getValues("name")).toBe("Server");
  });
});
