import { useMemo, useState, type ReactNode } from "react";
import { Download, File as FileIcon, Folder, Search, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@vantyr/ui/components/input-group";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import {
  DataTableSortSelect,
  type SortChoice,
} from "@/components/common/data-table/DataTableSortSelect";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import { formatFileSize, isHiddenFileName } from "./filePaths";
import type { FileItem } from "./useAgentFs";

const columnHelper = createDataTableColumns<FileItem>();

function matchesFileName(item: FileItem, query: string): boolean {
  return item.name.toLowerCase().includes(query.trim().toLowerCase());
}

/** Folders sort before files, then by name, ignoring case. */
function nameSortKey(item: FileItem): string {
  return `${item.is_dir ? "0" : "1"}${item.name.toLowerCase()}`;
}

const SORT_CHOICES: SortChoice[] = [
  { id: "name", desc: false, label: "Name A–Z" },
  { id: "name", desc: true, label: "Name Z–A" },
  { id: "size", desc: true, label: "Largest first" },
  { id: "size", desc: false, label: "Smallest first" },
];

function itemCount(shown: number, total: number): string {
  const word = total === 1 ? "item" : "items";
  return shown === total
    ? `${total.toLocaleString()} ${word}`
    : `${shown.toLocaleString()} of ${total.toLocaleString()} ${word}`;
}

/** The folder listing: name search, selectable rows, folder navigation and per-file download. */
export function FileTable({
  items,
  loading,
  selected,
  canUpload,
  atDrives,
  toolbar,
  selectionBar,
  onSelectedChange,
  onOpenFolder,
  onDownload,
  downloadDisabled,
}: {
  items: FileItem[];
  loading: boolean;
  selected: FileItem[];
  /** The folder accepts new files (so an empty folder can say how to fill it). */
  canUpload: boolean;
  /** Showing the drive list rather than a folder. */
  atDrives: boolean;
  /** Create/refresh controls, placed beside the search box. */
  toolbar: ReactNode;
  /** Actions on the selection; rendered between the search row and the list. */
  selectionBar: ReactNode;
  onSelectedChange: (update: (prev: FileItem[]) => FileItem[]) => void;
  onOpenFolder: (item: FileItem) => void;
  onDownload: (item: FileItem) => void;
  downloadDisabled: boolean;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");
  const hiddenCount = items.filter((item) => isHiddenFileName(item.name)).length;
  const shown = useMemo(
    () => (showHidden ? items : items.filter((item) => !isHiddenFileName(item.name))),
    [items, showHidden],
  );
  // What the search leaves: "select all" and the table both act on exactly this.
  const visible = useMemo(
    () => shown.filter((item) => matchesFileName(item, query)),
    [shown, query],
  );

  const isSelected = (item: FileItem) => selected.some((s) => s.name === item.name);
  const allSelected = visible.length > 0 && visible.every(isSelected);
  const someSelected = visible.some(isSelected) && !allSelected;
  const toggleSelected = (item: FileItem) => {
    onSelectedChange((prev) => {
      const already = prev.some((s) => s.name === item.name);
      return already ? prev.filter((s) => s.name !== item.name) : [...prev, item];
    });
  };
  // Only what is on screen: hidden or filtered-out files must never be selected by accident.
  const selectAllVisible = () =>
    onSelectedChange((prev) => [
      ...prev,
      ...visible.filter((item) => !prev.some((s) => s.name === item.name)),
    ]);
  const clearVisible = () =>
    onSelectedChange((prev) => prev.filter((s) => !visible.some((item) => item.name === s.name)));

  // Rebuilt each render: the cells read the current selection and transfer state.
  const columns = columnHelper.columns([
    columnHelper.display({
      id: "select",
      header: () => (
        <Checkbox
          aria-label="Select all files in this folder"
          checked={allSelected}
          indeterminate={someSelected}
          disabled={visible.length === 0}
          onCheckedChange={(checked) => (checked ? selectAllVisible() : clearVisible())}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`Select ${row.original.name}`}
          checked={isSelected(row.original)}
          onCheckedChange={() => toggleSelected(row.original)}
          className="pointer-coarse:size-6"
        />
      ),
      meta: { headerClassName: "w-12", stopRowClick: true },
    }),
    columnHelper.accessor(nameSortKey, {
      id: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex min-w-0 items-start gap-2">
            {item.is_dir ? (
              <Folder size={18} className="mt-0.5 shrink-0 text-primary" aria-label="Folder" />
            ) : (
              <FileIcon
                size={18}
                className="mt-0.5 shrink-0 text-muted-foreground"
                aria-label="File"
              />
            )}
            {item.is_dir ? (
              <button
                type="button"
                className="-my-1 min-h-7 min-w-0 cursor-pointer py-1 text-left wrap-break-word hover:underline max-sm:min-h-9 pointer-coarse:min-h-9 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                title={`Open ${item.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFolder(item);
                }}
              >
                {item.name}
              </button>
            ) : (
              <span className="min-w-0 wrap-break-word">{item.name}</span>
            )}
          </div>
        );
      },
      meta: { className: "w-full max-sm:w-auto max-sm:min-w-0 max-sm:flex-1" },
    }),
    columnHelper.accessor((item) => (item.is_dir ? undefined : item.size), {
      id: "size",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Size" />,
      cell: ({ row }) =>
        row.original.is_dir ? (
          <span className="max-sm:hidden">—</span>
        ) : (
          formatFileSize(row.original.size)
        ),
      meta: { className: "whitespace-nowrap font-mono text-xs text-muted-foreground" },
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) =>
        !row.original.is_dir && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="pointer-coarse:size-9 max-sm:size-9"
            aria-label={`Download ${row.original.name}`}
            title="Download"
            onClick={() => onDownload(row.original)}
            disabled={downloadDisabled}
          >
            <Download />
          </Button>
        ),
      meta: { stopRowClick: true },
    }),
  ]);

  const table = useDataTable({
    data: visible,
    columns,
    initialSorting: [{ id: "name", desc: false }],
  });
  const filtering = query.trim() !== "";
  const emptyText = filtering
    ? `No files or folders match “${query.trim()}”.`
    : atDrives
      ? "No drives found on this device."
      : canUpload
        ? "This folder is empty. Upload files or create a new folder."
        : "This folder is empty.";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2 sm:px-4">
        <InputGroup className="h-9 min-w-48 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search files and folders"
            placeholder="Search this folder"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        {toolbar}
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 text-[13px] text-muted-foreground tabular-nums sm:px-4">
        <span role="status">{itemCount(visible.length, shown.length)}</span>
        {hiddenCount > 0 && (
          <Button
            variant="link"
            size="sm"
            className="h-auto min-h-6 px-0 text-[13px] text-muted-foreground max-sm:min-h-9 pointer-coarse:min-h-9"
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden ? "Hide system files" : `Show ${hiddenCount} hidden`}
          </Button>
        )}
        {filtering && (
          <Button
            variant="ghost"
            size="xs"
            className="max-sm:h-9 pointer-coarse:h-9"
            onClick={() => setQuery("")}
          >
            Clear search
          </Button>
        )}
        {visible.length > 0 && !allSelected && (
          <Button
            variant="ghost"
            size="xs"
            className="max-sm:h-9 pointer-coarse:h-9 sm:hidden"
            onClick={selectAllVisible}
          >
            Select all
          </Button>
        )}
        <DataTableSortSelect
          table={table}
          choices={SORT_CHOICES}
          className="ml-auto w-36 sm:hidden"
        />
      </div>
      {selectionBar}
      <div className="px-2 pt-1 pb-2">
        <DataTable
          table={table}
          loading={loading}
          loadingText="Loading folder…"
          emptyText={emptyText}
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
