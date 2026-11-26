import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";

/** Consistent paging for rule, script and event tables, with optional row count. */
export function ListPagination({
  page,
  pages,
  onPageChange,
  count,
  item = "item",
}: {
  page: number;
  pages: number;
  onPageChange: (page: number) => void;
  count?: number;
  item?: string;
}) {
  if (pages <= 1 && count === undefined) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 px-4 py-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {pages > 1 && `Page ${page} of ${pages}`}
        {pages > 1 && count !== undefined && " · "}
        {count !== undefined && `${count} ${item}${count === 1 ? "" : "s"}`}
      </p>
      {pages > 1 && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => onPageChange(page + 1)}
            aria-label="Next page"
          >
            Next <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}
