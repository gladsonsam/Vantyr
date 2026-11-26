import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "bun:test";
import { useRowKeys } from "@/hooks/useRowKeys";

it("keeps editable input identity through edits, deletion and reordering", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Rows({ rows }: { rows: { value: string }[] }) {
    const keys = useRowKeys(rows);
    return rows.map((row, i) => (
      <input key={keys[i]} value={row.value} readOnly aria-label={row.value} />
    ));
  }
  const first = { value: "first" },
    second = { value: "second" },
    third = { value: "third" };
  try {
    await act(async () => root.render(<Rows rows={[first, second, third]} />));
    const inputs = Array.from(container.querySelectorAll("input"));
    const edited = { value: "edited" };
    await act(async () => root.render(<Rows rows={[first, edited, third]} />));
    expect(container.querySelectorAll("input")[1]).toBe(inputs[1]);
    await act(async () => root.render(<Rows rows={[edited, third]} />));
    expect(container.querySelectorAll("input")[0]).toBe(inputs[1]);
    await act(async () => root.render(<Rows rows={[third, edited]} />));
    expect(container.querySelectorAll("input")[1]).toBe(inputs[1]);
    const appended = { value: "appended" };
    await act(async () => root.render(<Rows rows={[third, edited, appended]} />));
    expect(container.querySelectorAll("input")[1]).toBe(inputs[1]);
    expect(container.querySelectorAll("input")[2]).not.toBe(inputs[2]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
