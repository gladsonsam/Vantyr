import { Fragment, type ComponentProps, type ReactNode } from "react";
import { FlexRender, type Row, type RowData } from "@tanstack/react-table";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vantyr/ui/components/table";
import { cn, fmtDayLabel, parseTimestamp } from "@/lib/utils";
import { isDayGrouped } from "./dayGroups";
import type { DataTableFeatures } from "./features";
import type { DataTableInstance } from "./useDataTable";

interface DataTableProps<TData extends RowData> {
  table: DataTableInstance<TData>;
  /** Shows `loadingText` instead of the empty state while there are no rows yet. */
  loading?: boolean;
  loadingText?: ReactNode;
  emptyText: ReactNode;
  /** Extra classes for the body, e.g. `[&_td]:align-top`. */
  bodyClassName?: string;
  /** Props for each body row (click handlers, selection state). */
  getRowProps?: (row: Row<DataTableFeatures, TData>) => ComponentProps<typeof TableRow>;
  /** Time column to group rows by day under one heading each (see `isDayGrouped`). */
  dayGroupColumn?: string;
}

function StateRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan}>{children}</TableCell>
    </TableRow>
  );
}

/**
 * Phones (below sm) get one block per row instead of a table wider than the screen: cells wrap
 * inline, so a column marked `max-sm:order-first max-sm:basis-full` reads as the row's title and the
 * rest as a line of details under it. `meta.label` prefixes a cell where the value alone is unclear.
 */
const STACKED =
  "max-sm:block max-sm:[&_thead]:hidden max-sm:[&_tbody]:block max-sm:[&_tr]:flex max-sm:[&_tr]:flex-wrap max-sm:[&_tr]:items-center max-sm:[&_tr]:gap-x-3 max-sm:[&_tr]:gap-y-1 max-sm:[&_tr]:px-3 max-sm:[&_tr]:py-3 " +
  "max-sm:[&_td]:block max-sm:[&_td]:w-auto! max-sm:[&_td]:min-w-0 max-sm:[&_td]:max-w-full! max-sm:[&_td]:whitespace-normal max-sm:[&_td]:p-0! max-sm:[&_td]:text-[13px] " +
  "max-sm:[&_td[data-label]]:before:mr-1.5 max-sm:[&_td[data-label]]:before:text-muted-foreground max-sm:[&_td[data-label]]:before:content-[attr(data-label)] " +
  "max-sm:[&_td:empty]:hidden";

/** The dashboard's list table: header with sort buttons, the current page of rows, and loading / empty rows. */
export function DataTable<TData extends RowData>({
  table,
  loading = false,
  loadingText = "Loading…",
  emptyText,
  bodyClassName,
  getRowProps,
  dayGroupColumn,
}: DataTableProps<TData>) {
  const rows = table.getRowModel().rows;
  const grouped = dayGroupColumn != null && isDayGrouped(table, dayGroupColumn);
  const dayOf = (row: Row<DataTableFeatures, TData>) => {
    const date = parseTimestamp(row.getValue(dayGroupColumn!) as string | number | undefined);
    return date ? { key: date.toDateString(), label: fmtDayLabel(date) } : null;
  };
  const columnCount = table.getAllLeafColumns().length;
  return (
    <Table className={STACKED}>
      <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id} className="hover:bg-transparent">
            {group.headers.map((header) => {
              const sorted = header.column.getIsSorted();
              return (
                <TableHead
                  key={header.id}
                  className={header.column.columnDef.meta?.headerClassName}
                  aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                >
                  {header.isPlaceholder ? null : <FlexRender header={header} />}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody className={cn("[&_td]:px-3 [&_td]:py-3.5", bodyClassName)}>
        {loading && rows.length === 0 ? (
          <StateRow colSpan={columnCount}>
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Spinner /> {loadingText}
            </div>
          </StateRow>
        ) : rows.length === 0 ? (
          <StateRow colSpan={columnCount}>
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">{emptyText}</div>
          </StateRow>
        ) : (
          rows.map((row, index) => {
            const day = grouped ? dayOf(row) : null;
            const previous = grouped && index > 0 ? dayOf(rows[index - 1]) : null;
            return (
            <Fragment key={row.id}>
            {day && day.key !== previous?.key && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className="bg-muted/40 py-1.5! text-xs font-medium text-muted-foreground max-sm:basis-full max-sm:-mx-3 max-sm:-my-3 max-sm:px-3! max-sm:py-1.5!">
                  {day.label}
                </TableCell>
              </TableRow>
            )}
            <TableRow {...getRowProps?.(row)} className={cn("group/row", getRowProps?.(row)?.className)}>
              {row.getAllCells().map((cell) => {
                const meta = cell.column.columnDef.meta;
                return (
                  <TableCell
                    key={cell.id}
                    data-label={meta?.label || undefined}
                    className={meta?.className}
                    onClick={meta?.stopRowClick ? (event) => event.stopPropagation() : undefined}
                  >
                    <FlexRender cell={cell} />
                  </TableCell>
                );
              })}
            </TableRow>
            </Fragment>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
