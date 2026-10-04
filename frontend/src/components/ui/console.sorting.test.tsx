// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Table } from "./console";
import { useCollection } from "../../hooks/useCollection";

const rows = [{ id: "a", score: 2 }, { id: "b", score: null }, { id: "c", score: 10 }, { id: "d", score: null }];
const columns = [
  { id: "id", header: "Device", cell: (row: typeof rows[number]) => row.id },
  { id: "score", header: "Score", sortingField: "score", cell: (row: typeof rows[number]) => row.score ?? "Unknown" },
];
function Harness() {
  const collection = useCollection(rows, { sorting: {} });
  return <Table items={collection.items} columnDefinitions={columns} {...collection.collectionProps} />;
}

describe("table sorting interaction", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("sorts numerically through the header and keeps unknowns last in both directions", () => {
    act(() => root.render(<Harness />));
    const header = host.querySelector<HTMLButtonElement>("thead button")!;
    const order = () => [...host.querySelectorAll("tbody tr")].map(row => row.firstElementChild?.textContent);
    act(() => header.click());
    expect(order()).toEqual(["a", "c", "b", "d"]);
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    act(() => header.click());
    expect(order()).toEqual(["c", "a", "b", "d"]);
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(host.querySelectorAll("thead button")).toHaveLength(1);
  });
});
