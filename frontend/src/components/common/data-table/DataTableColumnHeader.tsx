import type { Column, RowData } from "@tanstack/react-table";
import type { DataTableFeatures } from "./features";

/** Sortable header label: click to sort, click again to flip the direction. */
export function DataTableColumnHeader<TData extends RowData, TValue>({
  column,
  title,
}: {
  column: Column<DataTableFeatures, TData, TValue>;
  title: string;
}) {
  const sorted = column.getIsSorted();
  return (
    <button
      type="button"
      // First click uses the column's first direction (ascending unless `sortDescFirst`).
      onClick={() => column.toggleSorting(sorted ? sorted === "asc" : undefined)}
      className="inline-flex items-center gap-1.5 hover:text-foreground"
      aria-label={`Sort by ${title}`}
    >
      {title}
      {sorted && <span aria-hidden="true">{sorted === "desc" ? "↓" : "↑"}</span>}
    </button>
  );
}
