import { useState } from "react";
import {
  useTable,
  type ColumnDef,
  type RowData,
  type SortFn,
  type SortingState,
} from "@tanstack/react-table";
import { dataTableFeatures, type DataTableFeatures } from "./features";

export interface UseDataTableOptions<TData extends RowData> {
  /** Keep stable between renders (state or memo); a new array resets the table's row models. */
  data: TData[];
  /** Keep stable between renders (module scope or memo). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns carry their own value types
  columns: ColumnDef<DataTableFeatures, TData, any>[];
  /** Rows per page. Default 50. */
  pageSize?: number;
  initialSorting?: SortingState;
  /** Whole-row match for the search box (`table.setGlobalFilter`). Without it the search is a no-op. */
  filterFn?: (row: TData, query: string) => boolean;
}

/** Ascending comparison: numbers numerically, anything else as locale-aware text. */
export function compareSortValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
  return String(a).localeCompare(String(b));
}

// Row-type agnostic: it only reads cell values. Module scope keeps the column
// defaults stable across renders.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sortByValue: SortFn<DataTableFeatures, any> = (rowA, rowB, columnId) =>
  compareSortValues(rowA.getValue(columnId), rowB.getValue(columnId));
const defaultColumn = { sortFn: sortByValue, sortUndefined: "last" } as const;

/**
 * Client-side table state (sorting, search, pagination) for `DataTable`.
 *
 * Sorting compares with `compareSortValues`; accessors that return `undefined`
 * for a missing value keep those rows last in both directions. Columns sort
 * ascending first unless they set `sortDescFirst`. Changing the data, search or
 * sort returns to the first page.
 */
export function useDataTable<TData extends RowData>({
  data,
  columns,
  pageSize = 50,
  initialSorting = [],
  filterFn,
}: UseDataTableOptions<TData>) {
  const [initialState] = useState(() => ({
    sorting: initialSorting,
    globalFilter: "",
    pagination: { pageIndex: 0, pageSize },
  }));
  return useTable({
    features: dataTableFeatures,
    data,
    columns,
    initialState,
    defaultColumn,
    enableSortingRemoval: false,
    sortDescFirst: false,
    globalFilterFn: filterFn
      ? (row, _columnId, query) => filterFn(row.original, String(query))
      : undefined,
    // filterFn matches the whole row, so evaluate it once per row (against the
    // first accessor column) instead of once for every column.
    getColumnCanGlobalFilter: (column) =>
      column === column.table.getAllLeafColumns().find((c) => c.accessorFn),
  });
}

export type DataTableInstance<TData extends RowData> = ReturnType<typeof useDataTable<TData>>;
