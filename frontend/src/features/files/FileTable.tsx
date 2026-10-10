import { Download, File as FileIcon, Folder, Search, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@vantyr/ui/components/input-group";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { formatFileSize } from "./filePaths";
import type { FileItem } from "./useAgentFs";

const columnHelper = createDataTableColumns<FileItem>();

function matchesFileName(item: FileItem, query: string): boolean {
  return item.name.toLowerCase().includes(query.trim().toLowerCase());
}

/** The folder listing: name search, selectable rows, folder navigation and per-file download. */
export function FileTable({
  items,
  loading,
  selected,
  onSelectedChange,
  onOpenFolder,
  onDownload,
  downloadDisabled,
}: {
  items: FileItem[];
  loading: boolean;
  selected: FileItem[];
  onSelectedChange: (update: (prev: FileItem[]) => FileItem[]) => void;
  onOpenFolder: (item: FileItem) => void;
  onDownload: (item: FileItem) => void;
  downloadDisabled: boolean;
}) {
  const allSelected = items.length > 0 && items.every((it) => selected.some((s) => s.name === it.name));
  const someSelected = selected.length > 0 && !allSelected;
  const isSelected = (item: FileItem) => selected.some((s) => s.name === item.name);
  const toggleSelected = (item: FileItem) => {
    onSelectedChange((prev) => {
      const already = prev.some((s) => s.name === item.name);
      return already ? prev.filter((s) => s.name !== item.name) : [...prev, item];
    });
  };

  // Rebuilt each render: the cells read the current selection and transfer state.
  const columns = columnHelper.columns([
    columnHelper.display({
      id: "select",
      header: () => (
        <Checkbox
          aria-label="Select all files in this folder"
          checked={allSelected}
          indeterminate={someSelected}
          disabled={items.length === 0}
          onCheckedChange={(checked) => onSelectedChange(() => (checked ? [...items] : []))}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`Select ${row.original.name}`}
          checked={isSelected(row.original)}
          onCheckedChange={() => toggleSelected(row.original)}
        />
      ),
      meta: { headerClassName: "w-12", stopRowClick: true },
    }),
    columnHelper.display({
      id: "type",
      header: () => <span className="sr-only">Type</span>,
      cell: ({ row }) =>
        row.original.is_dir ? (
          <Folder size={18} className="text-primary" aria-label="Folder" />
        ) : (
          <FileIcon size={18} className="text-muted-foreground" aria-label="File" />
        ),
      meta: { headerClassName: "w-12" },
    }),
    columnHelper.accessor("name", {
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => {
        const item = row.original;
        return (
          <span
            className={item.is_dir ? "cursor-pointer hover:underline" : undefined}
            onClick={(e) => {
              if (!item.is_dir) return;
              e.stopPropagation();
              onOpenFolder(item);
            }}
          >
            {item.name}
          </span>
        );
      },
    }),
    columnHelper.display({
      id: "size",
      header: "Size",
      cell: ({ row }) => (row.original.is_dir ? "—" : formatFileSize(row.original.size)),
      meta: { className: "whitespace-nowrap font-mono text-xs" },
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) =>
        !row.original.is_dir && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Download ${row.original.name}`}
            onClick={() => onDownload(row.original)}
            disabled={downloadDisabled}
          >
            <Download />
          </Button>
        ),
      meta: { stopRowClick: true },
    }),
  ]);

  const table = useDataTable({ data: items, columns, filterFn: matchesFileName });
  const filterText = String(table.state.globalFilter ?? "");

  return (
    <>
      <div className="px-5 pt-3">
        <InputGroup className="h-9">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search files and folders"
            placeholder="Search files and folders"
            value={filterText}
            onChange={(e) => table.setGlobalFilter(e.target.value)}
          />
          {filterText && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => table.setGlobalFilter("")}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <p className="pt-1.5 text-xs text-muted-foreground">{table.getFilteredRowModel().rows.length} items</p>
      </div>
      <div className="px-2 py-2">
        <DataTable
          table={table}
          loading={loading}
          emptyText="Empty folder"
          getRowProps={(row) => ({
            "data-state": isSelected(row.original) ? "selected" : undefined,
            onClick: () => toggleSelected(row.original),
            className: "cursor-pointer",
          })}
        />
      </div>
      <div className="border-t border-foreground/[0.06] px-5 py-1 empty:hidden">
        <DataTablePagination table={table} />
      </div>
    </>
  );
}
