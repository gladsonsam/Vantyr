import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  metaHelper,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  type RowData,
} from "@tanstack/react-table";

/** Per-column presentation hints read by `DataTable`. */
export interface DataTableColumnMeta {
  /** Classes for the column's body cells. */
  className?: string;
  /** Classes for the column's header cell. */
  headerClassName?: string;
  /** Keep clicks inside the cell from reaching the row's `onClick` (checkbox / action cells). */
  stopRowClick?: boolean;
}

/** Client-side sorting, search and pagination: everything the dashboard tables use. */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

export type DataTableFeatures = typeof dataTableFeatures;

/** Column helper bound to the shared table features, for building `useDataTable` columns. */
export function createDataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}
