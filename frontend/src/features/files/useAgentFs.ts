import { useCallback, useEffect, useRef, useState } from "react";
import { useWsEvent } from "@/app/providers/useWsEvent";
import { DRIVES_PATH, joinPath } from "./filePaths";
import {
  ChunkAssembler,
  base64ToBytes,
  saveDownloadedFile,
  uint8ToBase64,
  uploadChunkCount,
  uploadChunkRange,
  uploadTimeoutMs,
} from "./fileTransfer";

export interface FileItem {
  name: string;
  is_dir: boolean;
  size: number;
}

export type FsOutcome = { ok: boolean; error?: string };
export type FsMessage = { ok: boolean; text: string };

/** Abandon a download after this long without a chunk (agent offline / dropped message). */
const DOWNLOAD_STALL_TIMEOUT_MS = 20_000;
const FS_OP_TIMEOUT_MS = 10_000;

/**
 * An agent's file system over the viewer WebSocket: directory listings, chunked downloads
 * (saved or shown as a text preview), chunked uploads and file operations (mkdir, copy,
 * rename/move, delete) with their progress and result messages.
 *
 * State belongs to one agent; remount (e.g. `key={agentId}`) to switch agents.
 */
export function useAgentFs({
  agentId,
  sendWsMessage,
  enabled = true,
  onListing,
}: {
  agentId: string;
  sendWsMessage: (msg: unknown) => void;
  /** When false nothing is requested from the agent (e.g. the viewer role). */
  enabled?: boolean;
  /** Called with each listing of the current folder (not the initial default-folder reply). */
  onListing?: (items: FileItem[]) => void;
}) {
  // Empty path means "agent default" (usually user's Documents).
  const [currentPath, setCurrentPath] = useState("");
  const [items, setItems] = useState<FileItem[]>([]);
  // Loading until the first reply lands (enabled mounts request one below).
  const [loading, setLoading] = useState(enabled);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  // Completed assembled download, handed to a post-commit effect to download/preview.
  const [completedDownload, setCompletedDownload] = useState<{ path: string; parts: Uint8Array[] } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [fsMessage, setFsMessage] = useState<FsMessage | null>(null);
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  const uploadWaiterRef = useRef<{ destPath: string; resolve: (outcome: FsOutcome) => void } | null>(null);
  const fsWaiterRef = useRef<{ requestId: string; resolve: (outcome: FsOutcome) => void } | null>(null);
  // Download chunks accumulate here (not in state) so the WS handler stays a pure
  // accumulator and side effects (save/preview) run from a post-commit effect.
  const chunksRef = useRef(new ChunkAssembler());
  const previewOpenRef = useRef(previewOpen);
  // Re-armed on every chunk received, so it only fires on genuine inactivity.
  const downloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDownloadTimeout = () => {
    if (downloadTimeoutRef.current) {
      clearTimeout(downloadTimeoutRef.current);
      downloadTimeoutRef.current = null;
    }
  };

  const armDownloadTimeout = (path: string) => {
    clearDownloadTimeout();
    downloadTimeoutRef.current = setTimeout(() => {
      downloadTimeoutRef.current = null;
      chunksRef.current.drop(path);
      setDownloading(null);
      setDownloadProgress(0);
      setPreviewLoading(false);
      setFsMessage({ ok: false, text: "Download timed out." });
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  };

  const send = (cmd: Record<string, unknown>) => sendWsMessage({ type: "control", agent_id: agentId, cmd });

  const requestDirectory = useCallback((path: string) => {
    if (!enabled) return;
    sendWsMessage({
      type: "control",
      agent_id: agentId,
      cmd: path ? { type: "ListDir", path } : { type: "ListDir" },
    });
  }, [agentId, sendWsMessage, enabled]);

  const loadDirectory = useCallback((path: string) => {
    if (!enabled) return;
    setLoading(true);
    requestDirectory(path);
  }, [enabled, requestDirectory]);

  useEffect(() => {
    requestDirectory(currentPath);
  }, [currentPath, requestDirectory]);

  useWsEvent(["dir_list", "file_upload_result", "file_chunk", "fs_op_result"], (data) => {
    if (data.agent_id !== agentId) return;

    if (data.event === "dir_list") {
      const payload = data.data;
      if (!payload) return;
      const path = typeof payload.path === "string" ? payload.path : "";
      // When `currentPath` is empty we asked the agent to pick a sensible default
      // (usually Documents). Accept the first reply and lock onto that path; the
      // path change below re-requests the listing, which owns the loading flag
      // until its reply lands.
      if (!currentPath) {
        if (path) {
          setCurrentPath(path);
          setLoading(true);
        } else {
          setLoading(false);
        }
        setItems(payload.items || []);
        return;
      }
      if (path && path.toLowerCase() === currentPath.toLowerCase()) {
        const freshItems = payload.items || [];
        setItems(freshItems);
        setLoading(false);
        onListing?.(freshItems);
      }
      return;
    }

    if (data.event === "file_upload_result") {
      const payload = data.data;
      const p = payload?.path;
      const w = uploadWaiterRef.current;
      if (!w || !p || !payload) return;
      if (p.toLowerCase() === w.destPath.toLowerCase()) {
        w.resolve({ ok: !!payload.ok, error: typeof payload.error === "string" ? payload.error : undefined });
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
        chunksRef.current.clear();
        setDownloadProgress(0);
        setPreviewLoading(false);
        const errText = typeof payload.data === "string" ? payload.data : "";
        setFsMessage({ ok: false, text: errText.trim() || "Download failed." });
        return;
      }
      const { path, chunk_index: index, total_chunks: total, data: chunkData } = payload;
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
        bytes = base64ToBytes(chunkData);
      } catch {
        clearDownloadTimeout();
        chunksRef.current.drop(path);
        setDownloading(null);
        setDownloadProgress(0);
        setPreviewLoading(false);
        setFsMessage({ ok: false, text: `Received a corrupt chunk for "${path.split("\\").pop()}".` });
        return;
      }

      const progress = chunksRef.current.add(path, index, total, bytes);
      setDownloadProgress(progress.status === "complete" ? 100 : progress.percent);
      if (progress.status === "complete") {
        clearDownloadTimeout();
        // Defer the actual save/preview to a post-commit effect so this handler
        // stays a pure accumulator (no double-fire under StrictMode/replay).
        setCompletedDownload({ path, parts: progress.parts });
      } else {
        // Still receiving chunks — push the stall deadline back out.
        armDownloadTimeout(path);
      }
      return;
    }

    const payload = data.data;
    const w = fsWaiterRef.current;
    if (!payload || !w) return;
    if (String(payload.request_id ?? "") !== w.requestId) return;
    w.resolve({ ok: !!payload.ok, error: typeof payload.error === "string" ? payload.error : undefined });
    fsWaiterRef.current = null;
  });

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
    if (previewOpenRef.current) {
      new Blob(parts as BlobPart[], { type: "application/octet-stream" })
        .text()
        .then((text) => setPreviewText(text))
        .catch(() => setPreviewText("(Could not decode file preview.)"))
        .finally(() => setPreviewLoading(false));
    } else {
      try {
        saveDownloadedFile(path, parts);
      } catch {
        setFsMessage({ ok: false, text: "Couldn't assemble the file." });
      }
    }
    setDownloading(null);
    setDownloadProgress(0);
    setCompletedDownload(null);
  }, [completedDownload]);

  const canUpload = Boolean(currentPath) && currentPath !== DRIVES_PATH;

  const startRead = (filePath: string) => {
    setDownloading(filePath);
    setDownloadProgress(0);
    chunksRef.current.clear();
    armDownloadTimeout(filePath);
    send({ type: "ReadFile", path: filePath });
  };

  /** Stream a file from the current folder and save it in the browser. */
  const download = (item: FileItem) => {
    setFsMessage(null);
    startRead(joinPath(currentPath, item.name));
  };

  /** Stream a file from the current folder into the text preview. */
  const openPreview = (item: FileItem) => {
    if (item.is_dir) return;
    setPreviewTitle(item.name);
    setPreviewText("");
    setPreviewLoading(true);
    setPreviewOpen(true);
    startRead(joinPath(currentPath, item.name));
  };

  const closePreview = () => {
    setPreviewOpen(false);
    setPreviewLoading(false);
    setPreviewText("");
  };

  /** Send one file-system command and wait for its `fs_op_result`; reloads the folder on success. */
  const runFsOp = async (cmd: Record<string, unknown>, label: string): Promise<FsOutcome> => {
    if (busyOp) return { ok: false, error: "Busy" };
    const requestId = crypto.randomUUID();
    setBusyOp(label);
    setFsMessage(null);

    const done = new Promise<FsOutcome>((resolve) => {
      fsWaiterRef.current = { requestId, resolve };
    });
    const timeout = new Promise<FsOutcome>((resolve) => {
      setTimeout(() => resolve({ ok: false, error: "Timed out." }), FS_OP_TIMEOUT_MS);
    });

    send({ ...cmd, request_id: requestId });

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

  const runUpload = async (file: File) => {
    if (!canUpload) return;
    const destPath = joinPath(currentPath, file.name);
    const totalChunks = uploadChunkCount(file.size);
    setUploadMessage(null);
    setUploading(destPath);
    setUploadProgress(0);

    const done = new Promise<FsOutcome>((resolve) => {
      uploadWaiterRef.current = { destPath, resolve };
    });
    const timeout = new Promise<FsOutcome>((resolve) => {
      setTimeout(() => resolve({ ok: false, error: "Upload timed out." }), uploadTimeoutMs(totalChunks));
    });

    try {
      for (let i = 0; i < totalChunks; i++) {
        const { start, end } = uploadChunkRange(i, file.size);
        const buf = new Uint8Array(await file.slice(start, end).arrayBuffer());
        send({
          type: "WriteFileChunk",
          path: destPath,
          chunk_index: i,
          total_chunks: totalChunks,
          data: uint8ToBase64(buf),
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

  /** Upload files into the current folder one after another. */
  const uploadFiles = async (files: File[]) => {
    if (!canUpload) return;
    for (const f of files) {
      await runUpload(f);
    }
  };

  const createEmptyFile = (name: string) => {
    if (!canUpload) return;
    const fileName = name.trim();
    if (!fileName) return;
    const destPath = joinPath(currentPath, fileName);
    setUploading(destPath);
    setUploadProgress(0);
    setUploadMessage(null);
    try {
      send({ type: "WriteFileChunk", path: destPath, chunk_index: 0, total_chunks: 1, data: "" });
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

  return {
    currentPath,
    // The path change below re-requests the listing, which owns the loading
    // flag until its reply lands.
    navigateTo: (path: string) => {
      setCurrentPath(path);
      if (enabled) setLoading(true);
    },
    reload: () => loadDirectory(currentPath),
    items,
    loading,
    canUpload,
    downloading,
    downloadProgress,
    download,
    preview: { open: previewOpen, title: previewTitle, text: previewText, loading: previewLoading },
    openPreview,
    closePreview,
    uploading,
    uploadProgress,
    uploadMessage,
    uploadFiles,
    createEmptyFile,
    busyOp,
    runFsOp,
    fsMessage,
    setFsMessage,
  };
}

export type AgentFs = ReturnType<typeof useAgentFs>;
