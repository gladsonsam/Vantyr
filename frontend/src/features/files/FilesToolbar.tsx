import { Plus, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type FileAction =
  | "copy_path"
  | "copy"
  | "cut"
  | "paste"
  | "download"
  | "preview"
  | "move"
  | "rename"
  | "delete";

const ACTIONS: { id: FileAction; label: string }[] = [
  { id: "copy_path", label: "Copy path" },
  { id: "copy", label: "Copy" },
  { id: "cut", label: "Move (cut)" },
  { id: "paste", label: "Paste" },
  { id: "download", label: "Download" },
  { id: "preview", label: "Preview" },
  { id: "move", label: "Move…" },
  { id: "rename", label: "Rename" },
  { id: "delete", label: "Delete" },
];

/** File browser header: refresh, New (folder/file), Upload and the selection Actions menu. */
export function FilesToolbar({
  refreshDisabled,
  createDisabled,
  actionsDisabled,
  isActionDisabled,
  onRefresh,
  onNewFolder,
  onNewFile,
  onUpload,
  onAction,
}: {
  refreshDisabled: boolean;
  /** New and Upload need a writable folder and no transfer in flight. */
  createDisabled: boolean;
  actionsDisabled: boolean;
  isActionDisabled: (action: FileAction) => boolean;
  onRefresh: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onUpload: () => void;
  onAction: (action: FileAction) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
      <h2 className="font-heading text-base font-medium">File Browser</h2>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" disabled={refreshDisabled} onClick={onRefresh}>
          <RefreshCw />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={createDisabled} />}>
            <Plus /> New
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onNewFolder}>Folder</DropdownMenuItem>
            <DropdownMenuItem onClick={onNewFile}>File</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" disabled={createDisabled} onClick={onUpload}>
          <Upload /> Upload
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={actionsDisabled} />}>
            Actions
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ACTIONS.map(({ id, label }) => (
              <DropdownMenuItem key={id} disabled={isActionDisabled(id)} onClick={() => onAction(id)}>
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
