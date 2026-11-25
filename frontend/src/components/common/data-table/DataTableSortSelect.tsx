import type { RowData } from "@tanstack/react-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@vantyr/ui/components/select";
import { cn } from "@/lib/utils";
import type { DataTableInstance } from "./useDataTable";

export interface SortChoice {
  /** Column id to sort by. */
  id: string;
  desc: boolean;
  label: string;
}

/**
 * Sorting for phones, where stacked rows have no column headers to press. One list of named orders
 * ("Newest first") that drives the same table sorting the headers do.
 */
export function DataTableSortSelect<TData extends RowData>({
  table,
  choices,
  className,
}: {
  table: DataTableInstance<TData>;
  choices: SortChoice[];
  className?: string;
}) {
  const current = table.state.sorting[0];
  const key = (id: string, desc: boolean) => `${id}:${desc ? "desc" : "asc"}`;
  const value = current ? key(current.id, current.desc) : "";
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const choice = choices.find((entry) => key(entry.id, entry.desc) === next);
        if (choice) table.setSorting([{ id: choice.id, desc: choice.desc }]);
      }}
    >
      <SelectTrigger size="sm" aria-label="Sort order" className={cn("min-w-0 data-[size=sm]:max-sm:h-9 data-[size=sm]:pointer-coarse:h-9", className)}>
        <SelectValue placeholder="Sort" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="min-w-44">
        {choices.map((choice) => (
          <SelectItem key={key(choice.id, choice.desc)} value={key(choice.id, choice.desc)}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
