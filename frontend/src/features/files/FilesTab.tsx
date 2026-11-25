import {
  createFileActionHandlers,
  type FileClipboard,
} from "./fileActionHandlers";
import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ComponentProps,
} from "react";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import type { DashboardRole } from "@/api/types";
import { cn } from "@/lib/utils";
import { DeleteFilesDialog, FilePreviewDialog } from "./FileDialogs";
import { DRIVES_PATH, baseName, breadcrumbs, joinPath } from "./filePaths";
import { FileTable } from "./FileTable";
import { FileBreadcrumbs, FileTransferStatus } from "./FileTransferStatus";
import { FileSelectionBar, FilesToolbar } from "./FilesToolbar";
import { NamePromptDialog } from "./NamePromptDialog";
import { useAgentFs, type FileItem } from "./useAgentFs";

interface FilesTabProps {
  agentId: string;
  sendWsMessage: (msg: unknown) => void;
  dashboardRole?: DashboardRole | null;
}

type Clipboard = FileClipboard;
type FilePromptKind = "mkdir" | "newFile" | "rename" | "move";

/** Remount per agent so every piece of browser state (path, selection, transfers, dialogs) resets. */
export function FilesTab(props: FilesTabProps) {
  return <FilesBrowser key={props.agentId} {...props} />;
}

function FilesBrowser({
  agentId,
  sendWsMessage,
  dashboardRole = null,
}: FilesTabProps) {
  const blockedByRole = dashboardRole === "viewer";
  const fs = useAgentFs({
    agentId,
    sendWsMessage,
    enabled: !blockedByRole,
  });
  const {
    selected,
    setSelected,
    currentPath,
    loading,
    downloading,
    uploading,
    busyOp,
    canUpload,
    runFsOp,
    setFsMessage,
  } = fs;

  const [dragOver, setDragOver] = useState(false);
  /** Which name prompt (new folder / new file / rename / move) is open. */
  const [prompt, setPrompt] = useState<FilePromptKind | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteReturnFocus = useRef<HTMLElement | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (blockedByRole) {
    return (
      <Alert>
        <Info />
        <AlertDescription>Browsing a device’s files needs the operator role.</AlertDescription>
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
    navigateTo(
      currentPath === DRIVES_PATH
        ? item.name
        : joinPath(currentPath, item.name),
    );
  };

  const {
    selectedPaths,
    selectedItem,
    selectedPath,
    oneSelected,
    oneFileSelected,
  } = selectedFileState(currentPath, selected);
  const transferring = downloading !== null || uploading !== null;

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
      const r = await runFsOp(
        { type: "DeletePath", path: p, recursive },
        "Delete",
      );
      if (!r.ok) break;
    }
    setSelected([]);
  };

  const { onAction, isActionDisabled } = createFileActionHandlers({
    selected,
    selectedItem,
    selectedPath,
    selectedPaths,
    oneSelected,
    oneFileSelected,
    clipboard,
    canUpload,
    downloading,
    fs,
    setFsMessage,
    setClipboard,
    setPrompt,
    setDeleteOpen: (open) => {
      if (open) deleteReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDeleteOpen(open);
    },
    copyText,
    paste,
  });

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

  const browserBusy = loading || transferring || busyOp !== null;
  const atDrives = currentPath === DRIVES_PATH;
  const location = currentPath && !atDrives ? currentPath : "";
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
          "rounded-xl border-2",
          dragOver ? "border-dashed border-primary bg-muted/50" : "border-transparent",
        )}
      >
        <div className="overflow-hidden rounded-xl bg-card pb-1">
          <FileBreadcrumbs
            crumbs={breadcrumbs(currentPath)}
            currentPath={currentPath}
            onNavigate={navigateTo}
            onCopyPath={() => void copyText(currentPath)}
          />

          <DropHint active={dragOver} location={location} />

          <FileTransferStatus
            downloading={downloading}
            downloadProgress={fs.downloadProgress}
            uploading={uploading}
            uploadProgress={fs.uploadProgress}
            uploadMessage={fs.uploadMessage}
            fsMessage={fs.fsMessage}
            onDismissUploadMessage={fs.dismissUploadMessage}
            onDismissFsMessage={() => setFsMessage(null)}
          />

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onFileInputChange}
          />

          <FileTable
            items={fs.items}
            loading={loading}
            selected={selected}
            canUpload={canUpload}
            atDrives={atDrives}
            toolbar={
              <FilesToolbar
                refreshing={browserBusy}
                createDisabled={!canUpload || browserBusy}
                clipboard={clipboardSummary(clipboard)}
                pasteDisabled={isActionDisabled("paste") || browserBusy}
                onRefresh={fs.reload}
                onNewFolder={() => setPrompt("mkdir")}
                onNewFile={() => setPrompt("newFile")}
                onUpload={() => fileInputRef.current?.click()}
                onPaste={() => onAction("paste")}
              />
            }
            selectionBar={
              <SelectionBarSlot
                selected={selected}
                disabled={browserBusy}
                isActionDisabled={isActionDisabled}
                onAction={onAction}
                onClear={() => setSelected([])}
              />
            }
            onSelectedChange={setSelected}
            onOpenFolder={openFolder}
            onDownload={fs.download}
            downloadDisabled={transferring}
          />
        </div>
      </div>

      <FileNamePrompts
        prompt={prompt}
        setPrompt={setPrompt}
        fs={fs}
        currentPath={currentPath}
        selectedItem={selectedItem}
        selectedPath={selectedPath}
        canUpload={canUpload}
        busyOp={busyOp}
      />

      <FilePreviewDialog preview={fs.preview} onClose={fs.closePreview} />

      <DeleteFilesDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        returnFocus={deleteReturnFocus}
        subject={
          selected.length === 1
            ? `"${selectedItem?.name ?? ""}"`
            : `${selected.length} items`
        }
        names={selected.map((item) => item.name)}
        folderCount={selected.filter((item) => item.is_dir).length}
        location={location}
        busy={busyOp !== null}
        disabled={selected.length === 0}
        onConfirm={(recursive) => void deleteSelection(recursive)}
      />
    </div>
  );
}

function clipboardSummary(clipboard: Clipboard | null) {
  return clipboard ? { mode: clipboard.mode, count: clipboard.srcPaths.length } : null;
}

/** Shown over the folder while files are dragged onto it. */
function DropHint({ active, location }: { active: boolean; location: string }) {
  if (!active) return null;
  return (
    <p role="status" className="px-3 pt-2 text-sm font-medium text-primary sm:px-4">
      Drop to upload to {location}
    </p>
  );
}

/** The actions for the current selection; nothing when nothing is selected. */
function SelectionBarSlot({
  selected,
  ...bar
}: { selected: FileItem[] } & Omit<ComponentProps<typeof FileSelectionBar>, "count" | "summary">) {
  if (selected.length === 0) return null;
  return <FileSelectionBar count={selected.length} summary={selected[0].name} {...bar} />;
}

type NamePromptContext = {
  prompt: FilePromptKind | null;
  setPrompt: (prompt: FilePromptKind | null) => void;
  fs: ReturnType<typeof useAgentFs>;
  currentPath: string;
  selectedItem: FileItem | null;
  selectedPath: string | null;
  canUpload: boolean;
  busyOp: string | null;
};
type NamePromptSpec = Omit<
  ComponentProps<typeof NamePromptDialog>,
  "open" | "onOpenChange"
> & { kind: FilePromptKind };
function createNamePromptSpecs({
  fs,
  currentPath,
  selectedItem,
  selectedPath,
  canUpload,
  busyOp,
}: NamePromptContext): NamePromptSpec[] {
  const busy = busyOp !== null;
  return [
    {
      kind: "mkdir",
      title: "New folder",
      description: currentPath ? `It will be created in ${currentPath}` : undefined,
      label: "Folder name",
      submitLabel: "Create",
      disabled: !canUpload || busy,
      onSubmit: (name) =>
        void fs.runFsOp(
          { type: "Mkdir", path: currentPath, name },
          "Create folder",
        ),
    },
    {
      kind: "newFile",
      title: "New file",
      description: currentPath ? `It will be created in ${currentPath}` : undefined,
      label: "File name",
      submitLabel: "Create",
      disabled: !canUpload || busy,
      onSubmit: (name) => {
        void fs.createEmptyFile(name);
      },
    },
    {
      kind: "rename",
      title: "Rename",
      label: "New name",
      initialValue: selectedItem?.name ?? "",
      submitLabel: "Rename",
      disabled: !selectedItem || !selectedPath || busy,
      onSubmit: (name) => {
        if (selectedPath)
          void fs.runFsOp(
            {
              type: "RenamePath",
              src: selectedPath,
              dst: joinPath(currentPath, name),
            },
            "Rename",
          );
      },
    },
    {
      kind: "move",
      title: "Move",
      description: "Full destination path.",
      label: "Destination path",
      placeholder: "C:\\Path\\to\\file",
      initialValue: selectedPath ?? "",
      submitLabel: "Move",
      disabled: !selectedPath || busy,
      onSubmit: (dst) => {
        if (selectedPath)
          void fs.runFsOp(
            { type: "RenamePath", src: selectedPath, dst },
            "Move",
          );
      },
    },
  ];
}
function FileNamePrompts(context: NamePromptContext) {
  return (
    <>
      {createNamePromptSpecs(context).map(({ kind, ...spec }) => (
        <NamePromptDialog
          key={kind}
          {...spec}
          open={context.prompt === kind}
          onOpenChange={(open) => context.setPrompt(open ? kind : null)}
        />
      ))}
    </>
  );
}

function selectedFileState(currentPath: string, selected: FileItem[]) {
  const selectedPaths =
    currentPath && currentPath !== DRIVES_PATH
      ? selected.map((s) => joinPath(currentPath, s.name))
      : [];
  const selectedItem = selected[0] ?? null;
  const selectedPath = selectedPaths[0] ?? null;
  const oneSelected = Boolean(
    selectedItem && selected.length === 1 && selectedPath,
  );
  const oneFileSelected = oneSelected && !selectedItem?.is_dir;

  return {
    selectedPaths,
    selectedItem,
    selectedPath,
    oneSelected,
    oneFileSelected,
  };
}
