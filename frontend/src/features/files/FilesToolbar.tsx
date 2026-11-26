import { Clipboard, Download, MoreHorizontal, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@vantyr/ui/components/dropdown-menu";
import { RefreshButton } from "@/components/common/RefreshButton";

export type FileAction =
  "copy_path" | "copy" | "cut" | "paste" | "download" | "preview" | "move" | "rename" | "delete";

/** Secondary actions on the selection, behind "More"; the everyday ones are buttons. */
const MORE_ACTIONS: { id: FileAction; label: string }[] = [
  { id: "preview", label: "Preview as text" },
  { id: "copy_path", label: "Copy path" },
  { id: "copy", label: "Copy" },
  { id: "cut", label: "Cut" },
  { id: "move", label: "Move to…" },
];

export interface FileClipboardSummary {
  mode: "copy" | "move";
  count: number;
}

/** Make something new or bring something in: refresh, New (folder/file), Upload, and Paste when something is cut or copied. */
export function FilesToolbar({
  refreshing,
  createDisabled,
  clipboard,
  pasteDisabled,
  onRefresh,
  onNewFolder,
  onNewFile,
  onUpload,
  onPaste,
}: {
  refreshing: boolean;
  /** New and Upload need a writable folder and no transfer in flight. */
  createDisabled: boolean;
  clipboard: FileClipboardSummary | null;
  pasteDisabled: boolean;
  onRefresh: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onUpload: () => void;
  onPaste: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <RefreshButton
        onClick={onRefresh}
        loading={refreshing}
        label="Refresh folder"
        className="max-sm:size-9 pointer-coarse:size-9"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="max-sm:h-9 pointer-coarse:h-9"
              disabled={createDisabled}
            />
          }
        >
          <Plus /> New
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onNewFolder}>Folder</DropdownMenuItem>
          <DropdownMenuItem onClick={onNewFile}>File</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="outline"
        size="sm"
        className="max-sm:h-9 pointer-coarse:h-9"
        disabled={createDisabled}
        onClick={onUpload}
      >
        <Upload /> Upload
      </Button>
      {clipboard ? (
        <Button
          variant="outline"
          size="sm"
          className="max-sm:h-9 pointer-coarse:h-9"
          disabled={pasteDisabled}
          onClick={onPaste}
        >
          <Clipboard /> Paste {clipboard.count} {clipboard.count === 1 ? "item" : "items"}
          <span className="sr-only">
            {clipboard.mode === "move" ? " (move here)" : " (copy here)"}
          </span>
        </Button>
      ) : null}
    </div>
  );
}

/** What you can do with the selected items: the count first, then actions, with the rest under More. */
export function FileSelectionBar({
  count,
  summary,
  disabled,
  isActionDisabled,
  onAction,
  onClear,
}: {
  count: number;
  /** One item: its name, so it is clear what the actions act on. */
  summary: string;
  /** A transfer or operation is running. */
  disabled: boolean;
  isActionDisabled: (action: FileAction) => boolean;
  onAction: (action: FileAction) => void;
  onClear: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Actions for selected items"
      className="mx-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg bg-muted/60 px-3 py-2 sm:mx-4"
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="min-w-0 font-medium wrap-break-word" title={summary}>
          {count === 1 ? summary : `${count} selected`}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 max-sm:h-9 pointer-coarse:h-9"
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="max-sm:h-9 pointer-coarse:h-9"
          disabled={disabled || isActionDisabled("download")}
          onClick={() => onAction("download")}
        >
          <Download /> Download
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="max-sm:h-9 pointer-coarse:h-9"
          disabled={disabled || isActionDisabled("rename")}
          onClick={() => onAction("rename")}
        >
          <Pencil /> Rename
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive max-sm:h-9 pointer-coarse:h-9"
          disabled={disabled || isActionDisabled("delete")}
          onClick={() => onAction("delete")}
        >
          <Trash2 /> Delete
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="max-sm:h-9 pointer-coarse:h-9"
                disabled={disabled}
              />
            }
          >
            <MoreHorizontal /> More
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {MORE_ACTIONS.slice(0, 2).map(({ id, label }) => (
              <DropdownMenuItem
                key={id}
                disabled={isActionDisabled(id)}
                onClick={() => onAction(id)}
              >
                {label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {MORE_ACTIONS.slice(2).map(({ id, label }) => (
              <DropdownMenuItem
                key={id}
                disabled={isActionDisabled(id)}
                onClick={() => onAction(id)}
              >
                {label}
                {id === "copy" && isActionDisabled(id) && count > 0 ? (
                  <span className="ml-auto text-xs text-muted-foreground">files only</span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
