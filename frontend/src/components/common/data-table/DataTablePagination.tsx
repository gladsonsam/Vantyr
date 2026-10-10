import type { RowData } from "@tanstack/react-table";
import { Button } from "@vantyr/ui/components/button";
import type { DataTableInstance } from "./useDataTable";

/** Previous / "Page n of m" / Next controls for a `useDataTable` table. Renders nothing for a single page. */
export function DataTablePagination<TData extends RowData>({ table }: { table: DataTableInstance<TData> }) {
  const page = table.state.pagination.pageIndex + 1;
  const pageCount = Math.max(1, table.getPageCount());
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2 py-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!table.getCanPreviousPage()}
        onClick={() => table.previousPage()}
      >
        Previous
      </Button>
      <span className="px-3 text-[13px] text-muted-foreground tabular-nums">
        Page {page} of {pageCount}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!table.getCanNextPage()}
        onClick={() => table.nextPage()}
      >
        Next
      </Button>
    </div>
  );
}
