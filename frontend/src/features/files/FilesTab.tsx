import { useRef, useState, type ChangeEvent } from "react";
import { ChevronRight, Download, Folder, File as FileIcon, Plus, RefreshCw, Search, Upload, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Info } from "lucide-react";
import { DataTable } from "@/components/common/data-table/DataTable";
import { DataTableColumnHeader } from "@/components/common/data-table/DataTableColumnHeader";
import { DataTablePagination } from "@/components/common/data-table/DataTablePagination";
import { createDataTableColumns } from "@/components/common/data-table/features";
import { useDataTable } from "@/components/common/data-table/useDataTable";
import type { DashboardRole } from "@/api/types";
import { cn } from "@/lib/utils";
import { DRIVES_PATH, breadcrumbs as pathBreadcrumbs, formatFileSize, joinPath } from "./filePaths";
import { useAgentFs, type FileItem } from "./useAgentFs";

interface FilesTabProps {
  agentId: string;
  sendWsMessage: (msg: unknown) => void;
  dashboardRole?: DashboardRole | null;
}

const columnHelper = createDataTableColumns<FileItem>();

function matchesFileName(item: FileItem, query: string): boolean {
  return item.name.toLowerCase().includes(query.trim().toLowerCase());
}

function Progress({ label, description, value }: { label: string; description: string; value: number }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="flex flex-col gap-1.5" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="text-[13px] font-bold">{label}</div>
      <div className="font-mono text-[11px] text-muted-foreground wrap-break-word">{description}</div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Remount per agent so every piece of browser state (path, selection, transfers, dialogs) resets. */
export function FilesTab(props: FilesTabProps) {
  return <FilesBrowser key={props.agentId} {...props} />;
}

function FilesBrowser({ agentId, sendWsMessage, dashboardRole = null }: FilesTabProps) {
  const blockedByRole = dashboardRole === "viewer";
  const [selected, setSelected] = useState<FileItem[]>([]);
  const fs = useAgentFs({
    agentId,
    sendWsMessage,
    enabled: !blockedByRole,
    // Defense in depth: drop any selected item that isn't actually in this
    // directory listing (guards against any stale-selection path).
    onListing: (freshItems) => {
      const names = new Set(freshItems.map((it) => it.name));
      setSelected((prev) => prev.filter((it) => names.has(it.name)));
    },
  });
  const {
    currentPath,
    items,
    loading,
    downloading,
    downloadProgress,
    uploading,
    uploadProgress,
    uploadMessage,
    fsMessage,
    setFsMessage,
    busyOp,
    canUpload,
    runFsOp,
  } = fs;

  const [dragOver, setDragOver] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDst, setMoveDst] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteRecursive, setDeleteRecursive] = useState(true);
  const [clipboard, setClipboard] = useState<
    | null
    | {
        mode: "copy" | "move";
        srcPaths: string[];
      }
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const navigateTo = (path: string) => {
    // Clear selection when changing directories — selections are scoped to the
    // current folder and shouldn't carry over (or match same-named items elsewhere).
    setSelected([]);
    fs.navigateTo(path);
  };

  const handleFileClick = (item: FileItem) => {
    if (item.is_dir) {
      if (currentPath === DRIVES_PATH) {
        navigateTo(item.name);
        return;
      }
      navigateTo(joinPath(currentPath, item.name));
    }
  };

  const selectedPaths =
    currentPath && currentPath !== DRIVES_PATH ? selected.map((s) => joinPath(currentPath, s.name)) : [];
  const selectedItem = selected[0] ?? null;
  const selectedPath = selectedPaths[0] ?? null;

  const breadcrumbs = pathBreadcrumbs(currentPath);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (list.length > 0) void fs.uploadFiles(list);
  };

  const allSelected = items.length > 0 && items.every((it) => selected.some((s) => s.name === it.name));
  const someSelected = selected.length > 0 && !allSelected;
  const isSelected = (item: FileItem) => selected.some((s) => s.name === item.name);
  const toggleSelected = (item: FileItem) => {
    setSelected((prev) => {
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
          onCheckedChange={(checked) => setSelected(checked ? [...items] : [])}
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
              handleFileClick(item);
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
            onClick={() => fs.download(row.original)}
            disabled={downloading !== null || uploading !== null}
          >
            <Download />
          </Button>
        ),
      meta: { stopRowClick: true },
    }),
  ]);

  const table = useDataTable({ data: items, columns, filterFn: matchesFileName });
  const filterText = String(table.state.globalFilter ?? "");

  const onCopyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFsMessage({ ok: true, text: "Copied to clipboard." });
    } catch {
      setFsMessage({ ok: false, text: "Couldn't copy." });
    }
  };

  if (blockedByRole) {
    return (
      <Alert>
        <Info />
        <AlertDescription>
          Operators only.
        </AlertDescription>
      </Alert>
    );
  }

  const opsDisabled = selected.length === 0 || loading || downloading !== null || uploading !== null || busyOp !== null;

  const onActionItem = (id: string) => {
    if (id === "copy_path" && selectedPath && selected.length === 1) {
      void onCopyText(selectedPath);
    }
    if (
      id === "download" &&
      selectedItem &&
      selectedPath &&
      selected.length === 1 &&
      !selectedItem.is_dir
    ) {
      fs.download(selectedItem);
    }
    if (
      id === "preview" &&
      selectedItem &&
      selected.length === 1 &&
      !selectedItem.is_dir
    ) {
      fs.openPreview(selectedItem);
    }
    if (id === "copy") {
      setClipboard({ mode: "copy", srcPaths: selectedPaths });
      setFsMessage({ ok: true, text: `Copied ${selectedPaths.length} item(s).` });
    }
    if (id === "cut") {
      setClipboard({ mode: "move", srcPaths: selectedPaths });
      setFsMessage({ ok: true, text: `Ready to move ${selectedPaths.length} item(s).` });
    }
    if (id === "paste" && clipboard && canUpload) {
      void (async () => {
        for (const src of clipboard.srcPaths) {
          const name = src.split("\\").filter(Boolean).pop() || "file";
          const dst = joinPath(currentPath, name);
          if (clipboard.mode === "move") {
            const r = await runFsOp({ type: "RenamePath", src, dst }, "Move");
            if (!r.ok) return;
          } else {
            const r = await runFsOp({ type: "CopyPath", src, dst }, "Copy");
            if (!r.ok) return;
          }
        }
        if (clipboard.mode === "move") setClipboard(null);
        fs.reload();
      })();
    }
    if (id === "move" && selectedPath && selected.length === 1) {
      setMoveDst(selectedPath);
      setMoveOpen(true);
    }
    if (id === "rename") {
      setRenameName(selectedItem?.name ?? "");
      setRenameOpen(true);
    }
    if (id === "delete") {
      setDeleteOpen(true);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragEnter={(e) => {
          if (!canUpload) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragOver={(e) => {
          if (!canUpload) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!canUpload) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
        }}
        onDrop={(e) => {
          if (!canUpload) return;
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length > 0) void fs.uploadFiles(files);
        }}
        className={cn(
          "rounded-lg border",
          dragOver ? "border-2 border-dashed border-primary bg-muted/50 p-3" : "border-transparent",
        )}
      >
        <nav aria-label="Current folder" className="flex flex-wrap items-center gap-1.5 text-[13px]">
          {breadcrumbs.map((crumb, idx) => {
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <span key={`${crumb.text}-${idx}`} className="flex items-center gap-1.5">
                {idx > 0 && <ChevronRight size={14} className="text-muted-foreground" aria-hidden="true" />}
                {isLast ? (
                  <span aria-current="page" className="font-medium text-muted-foreground">{crumb.text}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => navigateTo(crumb.path)}
                    className="text-primary hover:underline"
                  >
                    {crumb.text}
                  </button>
                )}
              </span>
            );
          })}
        </nav>

        {dragOver ? (
          <p className="pt-2 text-sm text-muted-foreground">
            Drop files to upload
          </p>
        ) : null}

        {downloading && (
          <div className="pt-3">
            <Progress
              value={downloadProgress}
              label="Downloading file"
              description={downloading}
            />
          </div>
        )}

        {uploading && (
          <div className="pt-3">
            <Progress
              value={uploadProgress}
              label="Uploading file"
              description={uploading}
            />
          </div>
        )}

        {uploadMessage && (
          <p className={cn(
            "pt-2 text-sm",
            /failed|timed out|rejected/i.test(uploadMessage) ? "text-destructive" : "text-success",
          )}>
            {uploadMessage}
          </p>
        )}

        {fsMessage ? (
          <div className="pt-3">
            <Alert variant={fsMessage.ok ? "default" : "destructive"}>
              <AlertDescription>{fsMessage.text}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onFileInputChange}
        />

        <div className="mt-3 overflow-hidden rounded-xl bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
            <h2 className="font-heading text-base font-medium">File Browser</h2>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                disabled={loading || downloading !== null || uploading !== null || busyOp !== null}
                onClick={fs.reload}
              >
                <RefreshCw />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canUpload || loading || downloading !== null || uploading !== null || busyOp !== null}
                    />
                  }
                >
                  <Plus /> New
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      setMkdirName("");
                      setMkdirOpen(true);
                    }}
                  >
                    Folder
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setNewFileName("");
                      setNewFileOpen(true);
                    }}
                  >
                    File
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                disabled={!canUpload || loading || downloading !== null || uploading !== null || busyOp !== null}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload /> Upload
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={opsDisabled} />}>
                  Actions
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={!selectedPath || selected.length !== 1}
                    onClick={() => onActionItem("copy_path")}
                  >
                    Copy path
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={selected.length === 0}
                    onClick={() => onActionItem("copy")}
                  >
                    Copy
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={selected.length === 0}
                    onClick={() => onActionItem("cut")}
                  >
                    Move (cut)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!clipboard || !canUpload}
                    onClick={() => onActionItem("paste")}
                  >
                    Paste
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={
                      !selectedItem ||
                      selected.length !== 1 ||
                      !!selectedItem?.is_dir ||
                      !selectedPath ||
                      downloading !== null
                    }
                    onClick={() => onActionItem("download")}
                  >
                    Download
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={
                      !selectedItem ||
                      selected.length !== 1 ||
                      !!selectedItem?.is_dir ||
                      !selectedPath ||
                      downloading !== null
                    }
                    onClick={() => onActionItem("preview")}
                  >
                    Preview
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!selectedItem || selected.length !== 1 || !selectedPath}
                    onClick={() => onActionItem("move")}
                  >
                    Move…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!selectedItem || selected.length !== 1 || !selectedPath}
                    onClick={() => onActionItem("rename")}
                  >
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={selected.length === 0}
                    onClick={() => onActionItem("delete")}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
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
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear search"
                    onClick={() => table.setGlobalFilter("")}
                  >
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
          <div className="border-t border-foreground/[0.06] px-5 py-1">
            <DataTablePagination table={table} />
          </div>
        </div>
      </div>

      <Dialog open={mkdirOpen} onOpenChange={setMkdirOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="Folder name"
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            placeholder="Folder name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMkdirOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!mkdirName.trim() || !canUpload || busyOp !== null}
              onClick={() => {
                setMkdirOpen(false);
                void runFsOp({ type: "Mkdir", path: currentPath, name: mkdirName.trim() }, "Create folder");
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New file</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="File name"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            placeholder="File name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFileOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newFileName.trim() || !canUpload || busyOp !== null}
              onClick={() => {
                setNewFileOpen(false);
                fs.createEmptyFile(newFileName);
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="New name"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            placeholder="New name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!renameName.trim() || !selectedItem || !selectedPath || busyOp !== null}
              onClick={() => {
                const src = selectedPath!;
                const dst = joinPath(currentPath, renameName.trim());
                setRenameOpen(false);
                void runFsOp({ type: "RenamePath", src, dst }, "Rename");
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move</DialogTitle>
            <DialogDescription>
              Full destination path.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Destination path"
            value={moveDst}
            onChange={(e) => setMoveDst(e.target.value)}
            placeholder="C:\\Path\\to\\file"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!selectedPath || !moveDst.trim() || busyOp !== null}
              onClick={() => {
                const src = selectedPath!;
                const dst = moveDst.trim();
                setMoveOpen(false);
                void runFsOp({ type: "RenamePath", src, dst }, "Move");
              }}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={fs.preview.open} onOpenChange={(open) => {
        if (!open) fs.closePreview();
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{fs.preview.title ? `Preview: ${fs.preview.title}` : "Preview"}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-xl bg-muted/50 p-3">
            <pre className="m-0 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
              {fs.preview.loading ? "Loading…" : fs.preview.text || "(Empty file.)"}
            </pre>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={fs.closePreview}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.length === 1 ? `"${selectedItem?.name ?? ""}"` : `${selected.length} items`}?</AlertDialogTitle>
            <AlertDialogDescription>
              This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={deleteRecursive}
              onCheckedChange={(checked) => setDeleteRecursive(checked === true)}
            />
            Delete folders recursively
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyOp !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={selected.length === 0 || busyOp !== null}
              onClick={() => {
                setDeleteOpen(false);
                void (async () => {
                  // Delete each selected path sequentially so we can reuse the existing waiter.
                  for (const p of selectedPaths) {
                    // For safety: only delete recursively when enabled (directories default true).
                    const recursive = deleteRecursive;
                    const r = await runFsOp({ type: "DeletePath", path: p, recursive }, "Delete");
                    if (!r.ok) break;
                  }
                  setSelected([]);
                })();
              }}
            >
              {busyOp !== null && <Spinner />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
