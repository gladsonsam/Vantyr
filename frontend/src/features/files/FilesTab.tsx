import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { DashboardRole } from "@/api/types";
import { cn } from "@/lib/utils";
import { DeleteFilesDialog, FilePreviewDialog } from "./FileDialogs";
import { DRIVES_PATH, baseName, breadcrumbs, joinPath } from "./filePaths";
import { FileTable } from "./FileTable";
import { FileBreadcrumbs, FileTransferStatus } from "./FileTransferStatus";
import { FilesToolbar, type FileAction } from "./FilesToolbar";
import { NamePromptDialog } from "./NamePromptDialog";
import { useAgentFs, type FileItem } from "./useAgentFs";

interface FilesTabProps {
  agentId: string;
  sendWsMessage: (msg: unknown) => void;
  dashboardRole?: DashboardRole | null;
}

type Clipboard = { mode: "copy" | "move"; srcPaths: string[] };

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
  const { currentPath, loading, downloading, uploading, busyOp, canUpload, runFsOp, setFsMessage } = fs;

  const [dragOver, setDragOver] = useState(false);
  /** Which name prompt (new folder / new file / rename / move) is open. */
  const [prompt, setPrompt] = useState<"mkdir" | "newFile" | "rename" | "move" | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (blockedByRole) {
    return (
      <Alert>
        <Info />
        <AlertDescription>Operators only.</AlertDescription>
      </Alert>
    );
  }

  const navigateTo = (path: string) => {
    // Clear selection when changing directories — selections are scoped to the
    // current folder and shouldn't carry over (or match same-named items elsewhere).
    setSelected([]);
    fs.navigateTo(path);
  };

  const openFolder = (item: FileItem) => {
    navigateTo(currentPath === DRIVES_PATH ? item.name : joinPath(currentPath, item.name));
  };

  const selectedPaths =
    currentPath && currentPath !== DRIVES_PATH ? selected.map((s) => joinPath(currentPath, s.name)) : [];
  const selectedItem = selected[0] ?? null;
  const selectedPath = selectedPaths[0] ?? null;
  const transferring = downloading !== null || uploading !== null;
  const oneSelected = Boolean(selectedItem && selected.length === 1 && selectedPath);
  const oneFileSelected = oneSelected && !selectedItem?.is_dir;

  const isActionDisabled = (action: FileAction): boolean => {
    switch (action) {
      case "copy_path":
        return !selectedPath || selected.length !== 1;
      case "copy":
      case "cut":
      case "delete":
        return selected.length === 0;
      case "paste":
        return !clipboard || !canUpload;
      case "download":
      case "preview":
        return !oneFileSelected || downloading !== null;
      case "move":
      case "rename":
        return !oneSelected;
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFsMessage({ ok: true, text: "Copied to clipboard." });
    } catch {
      setFsMessage({ ok: false, text: "Couldn't copy." });
    }
  };

  const paste = async (clip: Clipboard) => {
    for (const src of clip.srcPaths) {
      const dst = joinPath(currentPath, baseName(src) || "file");
      const r =
        clip.mode === "move"
          ? await runFsOp({ type: "RenamePath", src, dst }, "Move")
          : await runFsOp({ type: "CopyPath", src, dst }, "Copy");
      if (!r.ok) return;
    }
    if (clip.mode === "move") setClipboard(null);
    fs.reload();
  };

  const deleteSelection = async (recursive: boolean) => {
    // Delete each selected path sequentially so we can reuse the existing waiter.
    for (const p of selectedPaths) {
      const r = await runFsOp({ type: "DeletePath", path: p, recursive }, "Delete");
      if (!r.ok) break;
    }
    setSelected([]);
  };

  const onAction = (action: FileAction) => {
    switch (action) {
      case "copy_path":
        if (selectedPath && selected.length === 1) void copyText(selectedPath);
        break;
      case "download":
        if (oneFileSelected && selectedItem) fs.download(selectedItem);
        break;
      case "preview":
        if (oneFileSelected && selectedItem) fs.openPreview(selectedItem);
        break;
      case "copy":
        setClipboard({ mode: "copy", srcPaths: selectedPaths });
        setFsMessage({ ok: true, text: `Copied ${selectedPaths.length} item(s).` });
        break;
      case "cut":
        setClipboard({ mode: "move", srcPaths: selectedPaths });
        setFsMessage({ ok: true, text: `Ready to move ${selectedPaths.length} item(s).` });
        break;
      case "paste":
        if (clipboard && canUpload) void paste(clipboard);
        break;
      case "move":
        if (selectedPath && selected.length === 1) setPrompt("move");
        break;
      case "rename":
        setPrompt("rename");
        break;
      case "delete":
        setDeleteOpen(true);
        break;
    }
  };

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (list.length > 0) void fs.uploadFiles(list);
  };

  const dragHandler = (over: boolean) => (e: DragEvent<HTMLDivElement>) => {
    if (!canUpload) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(over);
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragEnter={dragHandler(true)}
        onDragOver={dragHandler(true)}
        onDragLeave={dragHandler(false)}
        onDrop={(e) => {
          dragHandler(false)(e);
          if (!canUpload) return;
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length > 0) void fs.uploadFiles(files);
        }}
        className={cn(
          "rounded-lg border",
          dragOver ? "border-2 border-dashed border-primary bg-muted/50 p-3" : "border-transparent",
        )}
      >
        <FileBreadcrumbs crumbs={breadcrumbs(currentPath)} onNavigate={navigateTo} />

        {dragOver ? <p className="pt-2 text-sm text-muted-foreground">Drop files to upload</p> : null}

        <FileTransferStatus
          downloading={downloading}
          downloadProgress={fs.downloadProgress}
          uploading={uploading}
          uploadProgress={fs.uploadProgress}
          uploadMessage={fs.uploadMessage}
          fsMessage={fs.fsMessage}
        />

        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFileInputChange} />

        <div className="mt-3 overflow-hidden rounded-xl bg-card">
          <FilesToolbar
            refreshDisabled={loading || transferring || busyOp !== null}
            createDisabled={!canUpload || loading || transferring || busyOp !== null}
            actionsDisabled={selected.length === 0 || loading || transferring || busyOp !== null}
            isActionDisabled={isActionDisabled}
            onRefresh={fs.reload}
            onNewFolder={() => setPrompt("mkdir")}
            onNewFile={() => setPrompt("newFile")}
            onUpload={() => fileInputRef.current?.click()}
            onAction={onAction}
          />
          <FileTable
            items={fs.items}
            loading={loading}
            selected={selected}
            onSelectedChange={setSelected}
            onOpenFolder={openFolder}
            onDownload={fs.download}
            downloadDisabled={transferring}
          />
        </div>
      </div>

      <NamePromptDialog
        open={prompt === "mkdir"}
        onOpenChange={(open) => setPrompt(open ? "mkdir" : null)}
        title="New folder"
        label="Folder name"
        submitLabel="Create"
        disabled={!canUpload || busyOp !== null}
        onSubmit={(name) => void runFsOp({ type: "Mkdir", path: currentPath, name }, "Create folder")}
      />

      <NamePromptDialog
        open={prompt === "newFile"}
        onOpenChange={(open) => setPrompt(open ? "newFile" : null)}
        title="New file"
        label="File name"
        submitLabel="Create"
        disabled={!canUpload || busyOp !== null}
        onSubmit={(name) => fs.createEmptyFile(name)}
      />

      <NamePromptDialog
        open={prompt === "rename"}
        onOpenChange={(open) => setPrompt(open ? "rename" : null)}
        title="Rename"
        label="New name"
        initialValue={selectedItem?.name ?? ""}
        submitLabel="Rename"
        disabled={!selectedItem || !selectedPath || busyOp !== null}
        onSubmit={(name) =>
          void runFsOp({ type: "RenamePath", src: selectedPath!, dst: joinPath(currentPath, name) }, "Rename")
        }
      />

      <NamePromptDialog
        open={prompt === "move"}
        onOpenChange={(open) => setPrompt(open ? "move" : null)}
        title="Move"
        description="Full destination path."
        label="Destination path"
        placeholder={"C:\\Path\\to\\file"}
        initialValue={selectedPath ?? ""}
        submitLabel="Move"
        disabled={!selectedPath || busyOp !== null}
        onSubmit={(dst) => void runFsOp({ type: "RenamePath", src: selectedPath!, dst }, "Move")}
      />

      <FilePreviewDialog preview={fs.preview} onClose={fs.closePreview} />

      <DeleteFilesDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        subject={selected.length === 1 ? `"${selectedItem?.name ?? ""}"` : `${selected.length} items`}
        busy={busyOp !== null}
        disabled={selected.length === 0}
        onConfirm={(recursive) => void deleteSelection(recursive)}
      />
    </div>
  );
}
