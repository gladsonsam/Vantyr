import type { FileAction } from "./FilesToolbar";
import type { AgentFs, FileItem } from "./useAgentFs";

export type FileClipboard = { mode: "copy" | "move"; srcPaths: string[] };
interface ActionContext {
  selected: FileItem[]; selectedItem: FileItem | null; selectedPath: string | null; selectedPaths: string[];
  oneSelected: boolean; oneFileSelected: boolean; clipboard: FileClipboard | null; canUpload: boolean; downloading: string | null;
  fs: Pick<AgentFs, "download" | "openPreview">; setFsMessage: AgentFs["setFsMessage"];
  setClipboard: (clipboard: FileClipboard | null) => void; setPrompt: (prompt: "move" | "rename") => void;
  setDeleteOpen: (open: boolean) => void; copyText: (text: string) => Promise<void>; paste: (clipboard: FileClipboard) => Promise<void>;
}
/** Keep toolbar/context-menu action guards and dispatch in one place. */
export function createFileActionHandlers({ selected, selectedItem, selectedPath, selectedPaths, oneSelected, oneFileSelected, clipboard, canUpload, downloading, fs, setFsMessage, setClipboard, setPrompt, setDeleteOpen, copyText, paste }: ActionContext) {
  const isActionDisabled = (action: FileAction): boolean => {
    switch (action) {
      case "copy_path":
        return !selectedPath || selected.length !== 1;
      case "copy":
        // The agent copies files only; a folder in the selection would fail on the device.
        return selected.length === 0 || selected.some((item) => item.is_dir);
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
  return { onAction, isActionDisabled };
}
