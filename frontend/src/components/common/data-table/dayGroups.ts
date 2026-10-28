import type { SortingState } from "@tanstack/react-table";

/** Any table instance, including the one a cell renderer receives. */
export type SortableTable = { store: { state: { sorting?: SortingState } } };

/**
 * Day grouping is on while the table is sorted by its time column (the default), so each day gets
 * one heading and rows show only the clock time. Sorting by anything else falls back to full dates.
 */
export function isDayGrouped(table: SortableTable, columnId: string): boolean {
  const sorting = table.store.state.sorting ?? [];
  return sorting.length === 0 || sorting[0]?.id === columnId;
}
