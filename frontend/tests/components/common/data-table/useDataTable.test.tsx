// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable, type DataTableInstance } from "@/components/common/data-table/useDataTable";

type Row = { id: string; name: string; score: number | null };
const rows: Row[] = [
  { id: "a", name: "beta", score: 2 },
  { id: "b", name: "Alpha", score: null },
  { id: "c", name: "gamma", score: 10 },
  { id: "d", name: "delta", score: null },
];
const helper = createDataTableColumns<Row>();
const columns = helper.columns([
  helper.accessor("name", { header: "Name" }),
  helper.accessor((row) => row.score ?? undefined, { id: "score", header: "Score" }),
]);

let table: DataTableInstance<Row> | null = null;
function Harness({ pageSize }: { pageSize?: number }) {
  const instance = useDataTable({
    data: rows,
    columns,
    pageSize,
    filterFn: (row, query) => row.name.toLowerCase().includes(query.toLowerCase()),
  });
  useEffect(() => {
    table = instance;
  }, [instance]);
  // Read the rows during render, as DataTable does: that is what recomputes the
  // row models and schedules the page reset.
  instance.getRowModel();
  return null;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  table = null;
});

function ids() {
  return table!.getRowModel().rows.map((row) => row.original.id);
}

it("sorts numerically and keeps missing values last in both directions", () => {
  act(() => root.render(<Harness />));
  expect(ids()).toEqual(["a", "b", "c", "d"]);
  act(() => table!.getColumn("score")!.toggleSorting(false));
  expect(ids()).toEqual(["a", "c", "b", "d"]);
  act(() => table!.getColumn("score")!.toggleSorting(true));
  expect(ids()).toEqual(["c", "a", "b", "d"]);
});

it("sorts text case-insensitively by locale", () => {
  act(() => root.render(<Harness />));
  act(() => table!.getColumn("name")!.toggleSorting());
  expect(ids()).toEqual(["b", "a", "d", "c"]);
});

it("searches whole rows and returns to the first page", async () => {
  act(() => root.render(<Harness pageSize={2} />));
  expect(table!.getPageCount()).toBe(2);
  act(() => table!.nextPage());
  expect(ids()).toEqual(["c", "d"]);
  await act(async () => table!.setGlobalFilter("ta"));
  expect(table!.state.pagination.pageIndex).toBe(0);
  expect(ids()).toEqual(["a", "d"]);
  expect(table!.getFilteredRowModel().rows).toHaveLength(2);
});
