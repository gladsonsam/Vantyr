import { useState, useEffect, useCallback, useRef, type ChangeEvent } from "react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Info } from "lucide-react";
import { useCollection } from "../../hooks/useCollection";
import type { DashboardRole } from "../../lib/types";
import { cn } from "@/lib/utils";

interface FileItem {
  name: string;
  is_dir: boolean;
  size: number;
}

interface FilesTabProps {
  agentId: string;
  sendWsMessage: (msg: unknown) => void;
  dashboardRole?: DashboardRole | null;
}

/** Payload from `window.dispatchEvent(new CustomEvent("vantyr-ws-event", { detail }))`. */
interface VantyrFileWsDetail {
  agent_id?: string;
  event?: string;
  data?: {
    path?: string;
    items?: FileItem[];
    ok?: boolean;
    error?: unknown;
    is_error?: boolean;
    chunk_index?: number;
    total_chunks?: number;
    data?: string;
    request_id?: string;
    op?: string;
    src?: string;
    dst?: string;
    recursive?: boolean;
  };
}

/** Raw bytes per upload chunk — must match agent `REMOTE_FILE_CHUNK_BYTES` in `agent/src/main.rs`. */
const REMOTE_FILE_CHUNK_BYTES = 3 * 1024 * 1024;

function Pager({ currentPageIndex, pagesCount, onChange }: {
  currentPageIndex: number;
  pagesCount: number;
  onChange: (event: { detail: { currentPageIndex: number } }) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 py-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={currentPageIndex <= 1}
        onClick={() => onChange({ detail: { currentPageIndex: currentPageIndex - 1 } })}
      >
        Previous
      </Button>
      <span className="px-3 text-[13px] text-muted-foreground tabular-nums">
        Page {currentPageIndex} of {pagesCount}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={currentPageIndex >= pagesCount}
        onClick={() => onChange({ detail: { currentPageIndex: currentPageIndex + 1 } })}
      >
        Next
      </Button>
    </div>
  );
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

export function FilesTab({ agentId, sendWsMessage, dashboardRole = null }: FilesTabProps) {
  const blockedByRole = dashboardRole === "viewer";

  const DRIVES_PATH = "__this_pc__";
  // Empty path means "agent default" (usually user's Documents).
  const [currentPath, setCurrentPath] = useState("");
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<FileItem[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  // Completed assembled download, handed to a post-commit effect to download/preview.
  const [completedDownload, setCompletedDownload] = useState<{ path: string; parts: Uint8Array[] } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fsMessage, setFsMessage] = useState<{ ok: boolean; text: string } | null>(null);
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
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [clipboard, setClipboard] = useState<
    | null
    | {
        mode: "copy" | "move";
        srcPaths: string[];
      }
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadWaiterRef = useRef<{
    destPath: string;
    resolve: (outcome: { ok: boolean; error?: string }) => void;
  } | null>(null);
  const fsWaiterRef = useRef<{
    requestId: string;
    resolve: (outcome: { ok: boolean; error?: string }) => void;
  } | null>(null);
  // Download chunks accumulate here (not in state) so the WS handler stays a pure
  // accumulator and side effects (save/preview) run from a post-commit effect. Each
  // chunk is decoded to bytes as soon as it arrives (rather than concatenating giant
  // base64 strings and decoding once at the end, which is both slow and — for large
  // files — has failed with base64-decode errors in practice).
  const chunksRef = useRef<Record<string, (Uint8Array | null)[]>>({});
  const previewOpenRef = useRef(previewOpen);
  // Guards against a download hanging forever (agent offline / dropped message):
  // re-armed on every chunk received, so it only fires on genuine inactivity.
  const downloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DOWNLOAD_STALL_TIMEOUT_MS = 20_000;

  const clearDownloadTimeout = () => {
    if (downloadTimeoutRef.current) {
      clearTimeout(downloadTimeoutRef.current);
      downloadTimeoutRef.current = null;
    }
  };

  const armDownloadTimeout = useCallback((path: string) => {
    clearDownloadTimeout();
    downloadTimeoutRef.current = setTimeout(() => {
      downloadTimeoutRef.current = null;
      delete chunksRef.current[path];
      setDownloading(null);
      setDownloadProgress(0);
      setPreviewLoading(false);
      setFsMessage({ ok: false, text: "Download timed out." });
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  }, []);

  const loadDirectory = useCallback((path: string) => {
    if (blockedByRole) return;
    setLoading(true);
    sendWsMessage({
      type: "control",
      agent_id: agentId,
      cmd: path ? { type: "ListDir", path } : { type: "ListDir" },
    });
  }, [agentId, sendWsMessage, blockedByRole]);

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  useEffect(() => {
    const onWsEvent = (event: Event) => {
      const data = (event as CustomEvent<VantyrFileWsDetail>).detail;
      if (!data || data.agent_id !== agentId) return;

      if (data.event === "dir_list") {
        const payload = data.data;
        if (!payload) return;
        const path = typeof payload.path === "string" ? payload.path : "";
        // When `currentPath` is empty we asked the agent to pick a sensible default
        // (usually Documents). Accept the first reply and lock onto that path.
        if (!currentPath) {
          if (path) setCurrentPath(path);
          setItems(payload.items || []);
          setLoading(false);
          return;
        }
        if (path && path.toLowerCase() === currentPath.toLowerCase()) {
          const freshItems = payload.items || [];
          setItems(freshItems);
          setLoading(false);
          // Defense in depth: drop any selected item that isn't actually in this
          // directory listing (guards against any stale-selection path).
          const names = new Set(freshItems.map((it) => it.name));
          setSelected((prev) => prev.filter((it) => names.has(it.name)));
        }
      }

      if (data.event === "file_upload_result") {
        if (data.agent_id !== agentId) return;
        const payload = data.data;
        const p = payload?.path;
        const w = uploadWaiterRef.current;
        if (!w || !p || !payload) return;
        if (p.toLowerCase() === w.destPath.toLowerCase()) {
          w.resolve({
            ok: !!payload.ok,
            error: typeof payload.error === "string" ? payload.error : undefined,
          });
          uploadWaiterRef.current = null;
        }
        return;
      }

      if (data.event === "file_chunk") {
        const payload = data.data;
        if (!payload) return;
        if (payload.is_error) {
          clearDownloadTimeout();
          setDownloading(null);
          chunksRef.current = {};
          setDownloadProgress(0);
          setPreviewLoading(false);
          const errText = typeof payload.data === "string" ? payload.data : "";
          setFsMessage({ ok: false, text: errText.trim() || "Download failed." });
          return;
        }
        const path = payload.path;
        const index = payload.chunk_index;
        const total = payload.total_chunks;
        const chunkData = payload.data;
        if (
          typeof path !== "string" ||
          typeof index !== "number" ||
          typeof total !== "number" ||
          typeof chunkData !== "string"
        ) {
          return;
        }

        let bytes: Uint8Array;
        try {
          const bin = atob(chunkData);
          bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        } catch {
          clearDownloadTimeout();
          delete chunksRef.current[path];
          setDownloading(null);
          setDownloadProgress(0);
          setPreviewLoading(false);
          setFsMessage({ ok: false, text: `Received a corrupt chunk for "${path.split("\\").pop()}".` });
          return;
        }

        const chunks = chunksRef.current[path] ?? new Array<Uint8Array | null>(total).fill(null);
        chunks[index] = bytes;
        chunksRef.current[path] = chunks;
        const received = chunks.filter((chunk) => chunk !== null).length;
        setDownloadProgress(Math.round((received / total) * 100));

        if (received === total) {
          clearDownloadTimeout();
          const parts = chunks as Uint8Array[];
          delete chunksRef.current[path];
          // Defer the actual save/preview to a post-commit effect so this handler
          // stays a pure accumulator (no double-fire under StrictMode/replay).
          setCompletedDownload({ path, parts });
        } else {
          // Still receiving chunks — push the stall deadline back out.
          armDownloadTimeout(path);
        }
      }

      if (data.event === "fs_op_result") {
        const payload = data.data;
        const w = fsWaiterRef.current;
        if (!payload || !w) return;
        if (String(payload.request_id ?? "") !== w.requestId) return;
        w.resolve({
          ok: !!payload.ok,
          error: typeof payload.error === "string" ? payload.error : undefined,
        });
        fsWaiterRef.current = null;
      }
    };

    window.addEventListener("vantyr-ws-event", onWsEvent as EventListener);
    return () => window.removeEventListener("vantyr-ws-event", onWsEvent as EventListener);
    // `armDownloadTimeout` is a `useCallback(…, [])`, so listing it here keeps the
    // rule satisfied without re-subscribing the listener on every render.
  }, [agentId, currentPath, armDownloadTimeout]);

  // Keep a ref of previewOpen so the completion effect reads the latest value.
  useEffect(() => {
    previewOpenRef.current = previewOpen;
  }, [previewOpen]);

  useEffect(() => clearDownloadTimeout, []);

  // Post-commit side effect: when a download finishes, either preview it or save
  // it. Driven by state so it fires exactly once (not inside a render/updater).
  useEffect(() => {
    if (!completedDownload) return;
    const { path, parts } = completedDownload;
    // Parts are already-decoded bytes (each chunk was decoded as it arrived), so
    // assembly here is just a Blob concatenation — no giant base64 string/decode.
    const blob = new Blob(parts as BlobPart[], { type: "application/octet-stream" });
    if (previewOpenRef.current) {
      blob
        .text()
        .then((text) => setPreviewText(text))
        .catch(() => setPreviewText("(Could not decode file preview.)"))
        .finally(() => setPreviewLoading(false));
    } else {
      try {
        // A `data:` URI embeds the whole file as base64 in the URL itself, which
        // blows past Chromium's ~2MB URL length cap for anything but tiny files
        // (fails with "Failed to construct 'URL': Invalid URL"). An object URL
        // backed by a Blob has no such limit.
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = path.split("\\").pop() || "file";
        link.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      } catch {
        setFsMessage({ ok: false, text: "Couldn't assemble the file." });
      }
    }
    setDownloading(null);
    setDownloadProgress(0);
    setCompletedDownload(null);
  }, [completedDownload]);

  const [prevAgentId, setPrevAgentId] = useState(agentId);

  if (agentId !== prevAgentId) {
    setPrevAgentId(agentId);
    setCurrentPath("");
    setItems([]);
    setLoading(false);
    setSelected([]);
    clearDownloadTimeout();
    setDownloading(null);
    setDownloadProgress(0);
    chunksRef.current = {};
    setCompletedDownload(null);
    setUploading(null);
    setUploadProgress(0);
    setUploadMessage(null);
    setFsMessage(null);
    setMkdirOpen(false);
    setMkdirName("");
    setRenameOpen(false);
    setRenameName("");
    setDeleteOpen(false);
    setBusyOp(null);
    uploadWaiterRef.current = null;
    fsWaiterRef.current = null;
  }

  const navigateTo = (path: string) => {
    // Clear selection when changing directories — selections are scoped to the
    // current folder and shouldn't carry over (or match same-named items elsewhere).
    setSelected([]);
    setCurrentPath(path);
  };

  const handleFileClick = (item: FileItem) => {
    if (item.is_dir) {
      if (currentPath === DRIVES_PATH) {
        navigateTo(item.name);
        return;
      }
      const newPath = currentPath.endsWith("\\")
        ? currentPath + item.name
        : currentPath + "\\" + item.name;
      navigateTo(newPath);
    }
  };

  const joinPath = (base: string, name: string) => {
    if (!base) return name;
    if (base.endsWith("\\")) return base + name;
    return base + "\\" + name;
  };

  const selectedPaths =
    currentPath && currentPath !== DRIVES_PATH ? selected.map((s) => joinPath(currentPath, s.name)) : [];
  const selectedItem = selected[0] ?? null;
  const selectedPath = selectedPaths[0] ?? null;

  const runFsOp = async (cmd: Record<string, unknown>, label: string) => {
    if (busyOp) return { ok: false, error: "Busy" };
    const requestId = crypto.randomUUID();
    setBusyOp(label);
    setFsMessage(null);

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      fsWaiterRef.current = { requestId, resolve };
    });
    const timeout = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      setTimeout(() => resolve({ ok: false, error: "Timed out." }), 10_000);
    });

    sendWsMessage({
      type: "control",
      agent_id: agentId,
      cmd: { ...cmd, request_id: requestId },
    });

    const outcome = await Promise.race([done, timeout]);
    fsWaiterRef.current = null;
    setBusyOp(null);
    if (outcome.ok) {
      setFsMessage({ ok: true, text: `${label} completed.` });
      loadDirectory(currentPath);
    } else {
      setFsMessage({ ok: false, text: outcome.error?.trim() || `${label} failed.` });
    }
    return outcome;
  };

  const runCopyPath = async (src: string, dst: string) => runFsOp({ type: "CopyPath", src, dst }, "Copy");

  const handleDownload = (item: FileItem) => {
    const filePath = currentPath.endsWith("\\")
      ? currentPath + item.name
      : currentPath + "\\" + item.name;

    setFsMessage(null);
    setDownloading(filePath);
    setDownloadProgress(0);
    chunksRef.current = {};
    armDownloadTimeout(filePath);

    sendWsMessage({
      type: "control",
      agent_id: agentId,
      cmd: { type: "ReadFile", path: filePath },
    });
  };

  const openPreview = (item: FileItem) => {
    if (item.is_dir) return;
    const filePath = currentPath.endsWith("\\")
      ? currentPath + item.name
      : currentPath + "\\" + item.name;
    setPreviewTitle(item.name);
    setPreviewText("");
    setPreviewLoading(true);
    setPreviewOpen(true);

    setDownloading(filePath);
    setDownloadProgress(0);
    chunksRef.current = {};
    armDownloadTimeout(filePath);
    sendWsMessage({
      type: "control",
      agent_id: agentId,
      cmd: { type: "ReadFile", path: filePath },
    });
  };

  const breadcrumbs = (() => {
    if (!currentPath || currentPath === DRIVES_PATH) return [{ text: "Root", path: DRIVES_PATH }];
    const parts = currentPath.split("\\").filter((p) => p);
    const crumbs = [{ text: "Root", path: DRIVES_PATH }];
    let accumulated = "";
    for (const part of parts) {
      accumulated += part + "\\";
      crumbs.push({ text: part, path: accumulated });
    }
    return crumbs;
  })();

  const canUpload =
    Boolean(currentPath) &&
    currentPath !== DRIVES_PATH;

  const uint8ToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const step = 8192;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
  };

  const runUpload = async (file: File) => {
    if (!canUpload) return;
    const destPath = currentPath.endsWith("\\")
      ? currentPath + file.name
      : currentPath + "\\" + file.name;
    const totalChunks = Math.max(1, Math.ceil(file.size / REMOTE_FILE_CHUNK_BYTES));
    setUploadMessage(null);
    setUploading(destPath);
    setUploadProgress(0);

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      uploadWaiterRef.current = { destPath, resolve };
    });
    // No fixed wall-clock cap: scale with chunk count (large files need more time).
    const timeoutMs = 30_000 + totalChunks * 2000;
    const timeout = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      setTimeout(
        () => resolve({ ok: false, error: "Upload timed out." }),
        timeoutMs,
      );
    });

    try {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * REMOTE_FILE_CHUNK_BYTES;
        const end = Math.min(start + REMOTE_FILE_CHUNK_BYTES, file.size);
        const slice = file.slice(start, end);
        const buf = new Uint8Array(await slice.arrayBuffer());
        const b64 = uint8ToBase64(buf);
        sendWsMessage({
          type: "control",
          agent_id: agentId,
          cmd: {
            type: "WriteFileChunk",
            path: destPath,
            chunk_index: i,
            total_chunks: totalChunks,
            data: b64,
          },
        });
        setUploadProgress(Math.round(((i + 1) / totalChunks) * 100));
      }

      const outcome = await Promise.race([done, timeout]);
      uploadWaiterRef.current = null;
      if (outcome.ok) {
        setUploadMessage("Upload finished.");
        loadDirectory(currentPath);
      } else {
        setUploadMessage(outcome.error?.trim() || "Upload failed.");
      }
    } catch {
      setUploadMessage("Upload failed.");
      uploadWaiterRef.current = null;
    } finally {
      setUploading(null);
      setUploadProgress(0);
    }
  };

  const runUploadMany = async (files: File[]) => {
    if (!canUpload) return;
    for (const f of files) {
      await runUpload(f);
    }
  };

  const createEmptyFile = async (name: string) => {
    if (!canUpload) return;
    const fileName = name.trim();
    if (!fileName) return;
    const destPath = currentPath.endsWith("\\") ? currentPath + fileName : currentPath + "\\" + fileName;
    setUploading(destPath);
    setUploadProgress(0);
    setUploadMessage(null);
    try {
      sendWsMessage({
        type: "control",
        agent_id: agentId,
        cmd: {
          type: "WriteFileChunk",
          path: destPath,
          chunk_index: 0,
          total_chunks: 1,
          data: "",
        },
      });
      setUploadProgress(100);
      setUploadMessage("File created.");
      loadDirectory(currentPath);
    } catch {
      setUploadMessage("Create file failed.");
    } finally {
      setUploading(null);
      setUploadProgress(0);
    }
  };

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (list.length > 0) void runUploadMany(list);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const { items: visibleItems, collectionProps, filterProps, paginationProps } = useCollection(items, {
    filtering: {
      empty: "Empty folder",
      noMatch: "No matches",
    },
    pagination: { pageSize: 50 },
    sorting: {},
  });

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

  const allSelected = items.length > 0 && items.every((it) => selected.some((s) => s.name === it.name));
  const someSelected = selected.length > 0 && !allSelected;
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
      handleDownload(selectedItem);
    }
    if (
      id === "preview" &&
      selectedItem &&
      selected.length === 1 &&
      !selectedItem.is_dir
    ) {
      openPreview(selectedItem);
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
            const r = await runCopyPath(src, dst);
            if (!r.ok) return;
          }
        }
        if (clipboard.mode === "move") setClipboard(null);
        loadDirectory(currentPath);
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
          if (files.length > 0) void runUploadMany(files);
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
                onClick={() => loadDirectory(currentPath)}
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
                onChange={(e) => {
                  setFilterText(e.target.value);
                  filterProps.onChange?.({ detail: { filteringText: e.target.value } });
                }}
              />
              {filterText && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear search"
                    onClick={() => {
                      setFilterText("");
                      filterProps.onChange?.({ detail: { filteringText: "" } });
                    }}
                  >
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            <p className="pt-1.5 text-xs text-muted-foreground">{visibleItems.length} items</p>
          </div>
          <div className="px-2 py-2">
            <Table>
              <TableHeader className="[&_tr]:border-foreground/[0.06] [&_th]:h-11 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12">
                    <Checkbox
                      aria-label="Select all files in this folder"
                      checked={allSelected}
                      indeterminate={someSelected}
                      disabled={items.length === 0}
                      onCheckedChange={(checked) => setSelected(checked ? [...items] : [])}
                    />
                  </TableHead>
                  <TableHead className="w-12"><span className="sr-only">Type</span></TableHead>
                  <SortableNameHead collectionProps={collectionProps} />
                  <TableHead>Size</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_td]:px-3 [&_td]:py-3.5">
                {loading && visibleItems.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5}>
                      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                        <Spinner /> Loading…
                      </div>
                    </TableCell>
                  </TableRow>
                ) : visibleItems.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5}>
                      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                        Empty folder
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  visibleItems.map((item: FileItem) => {
                    const checked = selected.some((s) => s.name === item.name);
                    return (
                      <TableRow
                        key={item.name}
                        data-state={checked ? "selected" : undefined}
                        onClick={() => {
                          setSelected((prev) => {
                            const already = prev.some((s) => s.name === item.name);
                            return already ? prev.filter((s) => s.name !== item.name) : [...prev, item];
                          });
                        }}
                        className="cursor-pointer"
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            aria-label={`Select ${item.name}`}
                            checked={checked}
                            onCheckedChange={() => {
                              setSelected((prev) => {
                                const already = prev.some((s) => s.name === item.name);
                                return already ? prev.filter((s) => s.name !== item.name) : [...prev, item];
                              });
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          {item.is_dir ? (
                            <Folder size={18} className="text-primary" aria-label="Folder" />
                          ) : (
                            <FileIcon size={18} className="text-muted-foreground" aria-label="File" />
                          )}
                        </TableCell>
                        <TableCell>
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
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {item.is_dir ? "—" : formatFileSize(item.size)}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          {!item.is_dir && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Download ${item.name}`}
                              onClick={() => handleDownload(item)}
                              disabled={downloading !== null || uploading !== null}
                            >
                              <Download />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          <div className="border-t border-foreground/[0.06] px-5 py-1">
            <Pager {...paginationProps} />
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
                void createEmptyFile(newFileName);
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

      <Dialog open={previewOpen} onOpenChange={(open) => {
        setPreviewOpen(open);
        if (!open) {
          setPreviewLoading(false);
          setPreviewText("");
        }
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{previewTitle ? `Preview: ${previewTitle}` : "Preview"}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-xl bg-muted/50 p-3">
            <pre className="m-0 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
              {previewLoading ? "Loading…" : previewText || "(Empty file.)"}
            </pre>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPreviewOpen(false);
                setPreviewLoading(false);
                setPreviewText("");
              }}
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

function SortableNameHead({ collectionProps }: {
  collectionProps: {
    onSortingChange: (event: { detail: { sortingColumn?: { sortingField?: string }; isDescending?: boolean } }) => void;
    sortingColumn?: { sortingField?: string };
    isDescending?: boolean;
  };
}) {
  const { sortingColumn, isDescending, onSortingChange } = collectionProps;
  const active = sortingColumn?.sortingField === "name";
  return (
    <TableHead aria-sort={active ? (isDescending ? "descending" : "ascending") : undefined}>
      <button
        type="button"
        onClick={() => onSortingChange({
          detail: {
            sortingColumn: { sortingField: "name" },
            isDescending: active ? !isDescending : false,
          },
        })}
        className="inline-flex items-center gap-1.5 hover:text-foreground"
        aria-label="Sort by name"
      >
        Name
        {active && <span aria-hidden="true">{isDescending ? "↓" : "↑"}</span>}
      </button>
    </TableHead>
  );
}
