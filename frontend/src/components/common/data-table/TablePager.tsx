import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { cn } from "@/lib/utils";
import { PAGE_SIZE_ALL, PAGE_SIZE_OPTIONS } from "./pagination";

/**
 * Arcane's table footer row: a "rows per page" select on the left, the visible range with
 * previous/next arrows on the right.
 */
export function TablePager({
  total,
  page,
  pages,
  pageSize,
  onPage,
  onPageSize,
  className,
}: {
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  className?: string;
}) {
  const start = total === 0 ? 0 : pageSize === PAGE_SIZE_ALL ? 1 : (page - 1) * pageSize + 1;
  const end = pageSize === PAGE_SIZE_ALL ? total : Math.min(total, page * pageSize);
  return (
    <nav
      aria-label="Pagination"
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span>Rows per page</span>
        <Select value={String(pageSize)} onValueChange={(value) => onPageSize(Number(value))}>
          <SelectTrigger size="sm" aria-label="Rows per page" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size === PAGE_SIZE_ALL ? "All" : String(size)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-1">
        <span className="px-2 tabular-nums">
          {start}–{end} of {total}
        </span>
        {pages > 1 && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => onPage(page - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next page"
              disabled={page >= pages}
              onClick={() => onPage(page + 1)}
            >
              <ChevronRight />
            </Button>
          </>
        )}
      </div>
    </nav>
  );
}
