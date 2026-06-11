import { Table, Box, Header, BreadcrumbGroup, Button, ButtonDropdown, ProgressBar, Icon, SpaceBetween, Modal, Input, Alert, TextFilter, Pagination, Toggle, useCollection } from "../ui/console";
import { useState, useEffect, useCallback, useRef, type ChangeEvent } from "react";
import type { DashboardRole } from "../../lib/types";

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
  const [, setChunksByPath] = useState<Record<string, string[]>>({});
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
          setItems(payload.items || []);
          setLoading(false);
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
          setDownloading(null);
          setChunksByPath({});
          setDownloadProgress(0);
          setPreviewLoading(false);
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

        setChunksByPath((prev) => {
          const chunks = prev[path] ? [...prev[path]] : new Array(total).fill("");
          chunks[index] = chunkData;
          const received = chunks.filter((chunk) => chunk !== "").length;
          setDownloadProgress(Math.round((received / total) * 100));

          if (received === total) {
            const fullBase64 = chunks.join("");
            if (previewOpen) {
              try {
                const bin = atob(fullBase64);
                const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
                const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
                setPreviewText(text);
              } catch {
                setPreviewText("(Could not decode file preview.)");
              } finally {
                setPreviewLoading(false);
              }
            } else {
              const link = document.createElement("a");
              link.href = `data:application/octet-stream;base64,${fullBase64}`;
              link.download = path.split("\\").pop() || "file";
              link.click();
            }
            setDownloading(null);
            setDownloadProgress(0);
            const clone = { ...prev };
            delete clone[path];
            return clone;
          }

          return { ...prev, [path]: chunks };
        });
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
  }, [agentId, currentPath, previewOpen]);

  useEffect(() => {
    setCurrentPath("");
    setItems([]);
    setLoading(false);
    setSelected([]);
    setDownloading(null);
    setDownloadProgress(0);
    setChunksByPath({});
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
  }, [agentId]);

  const navigateTo = (path: string) => {
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
      setTimeout(() => resolve({ ok: false, error: "Timed out waiting for the agent." }), 10_000);
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
    
    setDownloading(filePath);
    setDownloadProgress(0);
    
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
    setChunksByPath({});
    sendWsMessage({
      type: "control",
      agent_id: agentId,
      cmd: { type: "ReadFile", path: filePath },
    });
  };

  const getBreadcrumbs = () => {
    if (!currentPath || currentPath === DRIVES_PATH) return [{ text: "Root", href: "#" }];

    const parts = currentPath.split("\\").filter((p) => p);
    const breadcrumbs = [{ text: "Root", href: "#" }];
    
    let accumulated = "";
    for (const part of parts) {
      accumulated += part + "\\";
      breadcrumbs.push({ text: part, href: "#" + accumulated });
    }
    
    return breadcrumbs;
  };

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
        () => resolve({ ok: false, error: "Upload timed out waiting for the agent." }),
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
      empty: (
        <Box textAlign="center" color="inherit">
          <Box variant="p" color="inherit">
            Directory is empty
          </Box>
        </Box>
      ),
      noMatch: (
        <Box textAlign="center" color="inherit">
          <Box variant="p" color="inherit">
            No matches
          </Box>
        </Box>
      ),
    },
    pagination: { pageSize: 50 },
    sorting: {},
  });

  const onCopyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFsMessage({ ok: true, text: "Copied to clipboard." });
    } catch {
      setFsMessage({ ok: false, text: "Could not copy to clipboard." });
    }
  };

  if (blockedByRole) {
    return (
      <Alert type="info" header="Operator role required">
        Remote file browsing requires the <strong>operator</strong> or <strong>admin</strong> role.
      </Alert>
    );
  }

  return (
    <SpaceBetween size="l">
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
        style={{
          border: dragOver ? "2px dashed var(--gr)" : "1px solid transparent",
          borderRadius: 8,
          padding: dragOver ? 12 : 0,
          background: dragOver ? "var(--card-2)" : "transparent",
        }}
      >
      <Box padding={{ bottom: "s" }}>
        <BreadcrumbGroup
          items={getBreadcrumbs()}
          onFollow={(e: any) => {
            e.preventDefault();
            const href = e.detail.href;
            if (href === "#") {
              // "Root" means "This PC" (drive list), not the agent's default folder.
              navigateTo(DRIVES_PATH);
            } else {
              navigateTo(href.substring(1));
            }
          }}
        />
      </Box>

      {dragOver ? (
        <Box margin={{ top: "s" }} color="text-body-secondary">
          Drop files to upload
        </Box>
      ) : null}

      {downloading && (
        <ProgressBar
          value={downloadProgress}
          label="Downloading file"
          description={downloading}
        />
      )}

      {uploading && (
        <ProgressBar
          value={uploadProgress}
          label="Uploading file"
          description={uploading}
        />
      )}

      {uploadMessage && (
        <Box color={uploadMessage.includes("failed") || uploadMessage.includes("timed out") || uploadMessage.includes("rejected") ? "text-status-error" : "text-status-success"}>
          {uploadMessage}
        </Box>
      )}

      {fsMessage ? (
        <Alert type={fsMessage.ok ? "success" : "error"}>{fsMessage.text}</Alert>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={onFileInputChange}
      />

      <Table
        loading={loading}
        loadingText="Loading directory..."
        columnDefinitions={[
          {
            id: "icon",
            header: "",
            cell: (item) => (
              <Icon
                name={item.is_dir ? "folder" : "file"}
                size="medium"
              />
            ),
            width: 50,
          },
          {
            id: "name",
            header: "Name",
            cell: (item) => (
              <span
                style={{ cursor: item.is_dir ? "pointer" : "default" }}
                onClick={() => item.is_dir && handleFileClick(item)}
              >
                {item.name}
              </span>
            ),
            sortingField: "name",
          },
          {
            id: "size",
            header: "Size",
            cell: (item) => (item.is_dir ? "—" : formatFileSize(item.size)),
            width: 120,
          },
          {
            id: "actions",
            header: "Actions",
            cell: (item) =>
              !item.is_dir && (
                <Button
                  iconName="download"
                  variant="inline-icon"
                  onClick={() => handleDownload(item)}
                  disabled={downloading !== null || uploading !== null}
                />
              ),
            width: 100,
          },
        ]}
        {...collectionProps}
        items={visibleItems}
        trackBy={(item: any) => item.name}
        selectionType="multi"
        selectedItems={selected}
        onSelectionChange={({ detail }) => setSelected(detail.selectedItems)}
        onRowClick={({ detail }: any) => {
          const item = detail.item as FileItem;
          setSelected((prev) => {
            const already = prev.some((s) => s.name === item.name);
            return already ? prev.filter((s) => s.name !== item.name) : [...prev, item];
          });
        }}
        variant="container"
        stickyHeader
        filter={
          <TextFilter
            {...filterProps}
            filteringText={filterText}
            onChange={({ detail }) => {
              setFilterText(detail.filteringText);
              filterProps.onChange?.({ detail });
            }}
            countText={`${visibleItems.length} items`}
            filteringPlaceholder="Search files and folders"
          />
        }
        pagination={<Pagination {...paginationProps} />}
        header={
          <Header
            actions={
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <Button
                  disabled={loading || downloading !== null || uploading !== null || busyOp !== null}
                  iconName="refresh"
                  variant="icon"
                  ariaLabel="Refresh"
                  onClick={() => loadDirectory(currentPath)}
                />
                <ButtonDropdown
                  items={[
                    { id: "new_folder", text: "Folder" },
                    { id: "new_file", text: "File" },
                  ]}
                  disabled={!canUpload || loading || downloading !== null || uploading !== null || busyOp !== null}
                  onItemClick={({ detail }) => {
                    if (detail.id === "new_folder") {
                      setMkdirName("");
                      setMkdirOpen(true);
                    }
                    if (detail.id === "new_file") {
                      setNewFileName("");
                      setNewFileOpen(true);
                    }
                  }}
                >
                  New
                </ButtonDropdown>
                <Button
                  disabled={!canUpload || loading || downloading !== null || uploading !== null || busyOp !== null}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Upload
                </Button>
                <ButtonDropdown
                  items={[
                    {
                      id: "copy_path",
                      text: "Copy path",
                      disabled: !selectedPath || selected.length !== 1,
                    },
                    {
                      id: "copy",
                      text: "Copy",
                      disabled: selected.length === 0,
                    },
                    {
                      id: "cut",
                      text: "Move (cut)",
                      disabled: selected.length === 0,
                    },
                    {
                      id: "paste",
                      text: "Paste",
                      disabled: !clipboard || !canUpload,
                    },
                    {
                      id: "download",
                      text: "Download",
                      disabled:
                        !selectedItem ||
                        selected.length !== 1 ||
                        !!selectedItem?.is_dir ||
                        !selectedPath ||
                        downloading !== null,
                    },
                    {
                      id: "preview",
                      text: "Preview",
                      disabled:
                        !selectedItem ||
                        selected.length !== 1 ||
                        !!selectedItem?.is_dir ||
                        !selectedPath ||
                        downloading !== null,
                    },
                    {
                      id: "move",
                      text: "Move…",
                      disabled: !selectedItem || selected.length !== 1 || !selectedPath,
                    },
                    {
                      id: "rename",
                      text: "Rename",
                      disabled: !selectedItem || selected.length !== 1 || !selectedPath,
                    },
                    {
                      id: "delete",
                      text: "Delete",
                      disabled: selected.length === 0,
                    },
                  ]}
                  disabled={selected.length === 0 || loading || downloading !== null || uploading !== null || busyOp !== null}
                  onItemClick={({ detail }) => {
                    if (detail.id === "copy_path" && selectedPath && selected.length === 1) {
                      void onCopyText(selectedPath);
                    }
                    if (
                      detail.id === "download" &&
                      selectedItem &&
                      selectedPath &&
                      selected.length === 1 &&
                      !selectedItem.is_dir
                    ) {
                      handleDownload(selectedItem);
                    }
                    if (
                      detail.id === "preview" &&
                      selectedItem &&
                      selected.length === 1 &&
                      !selectedItem.is_dir
                    ) {
                      openPreview(selectedItem);
                    }
                    if (detail.id === "copy") {
                      setClipboard({ mode: "copy", srcPaths: selectedPaths });
                      setFsMessage({ ok: true, text: `Copied ${selectedPaths.length} item(s).` });
                    }
                    if (detail.id === "cut") {
                      setClipboard({ mode: "move", srcPaths: selectedPaths });
                      setFsMessage({ ok: true, text: `Ready to move ${selectedPaths.length} item(s).` });
                    }
                    if (detail.id === "paste" && clipboard && canUpload) {
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
                    if (detail.id === "move" && selectedPath && selected.length === 1) {
                      setMoveDst(selectedPath);
                      setMoveOpen(true);
                    }
                    if (detail.id === "rename") {
                      setRenameName(selectedItem?.name ?? "");
                      setRenameOpen(true);
                    }
                    if (detail.id === "delete") {
                      setDeleteOpen(true);
                    }
                  }}
                >
                  Actions
                </ButtonDropdown>
              </div>
            }
          >
            File Browser
          </Header>
        }
      />

      <Modal
        visible={mkdirOpen}
        onDismiss={() => setMkdirOpen(false)}
        header="New folder"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setMkdirOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!mkdirName.trim() || !canUpload || busyOp !== null}
                onClick={() => {
                  setMkdirOpen(false);
                  void runFsOp({ type: "Mkdir", path: currentPath, name: mkdirName.trim() }, "Create folder");
                }}
              >
                Create
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box color="text-body-secondary">Create a folder inside the current directory.</Box>
          <Input value={mkdirName} onChange={({ detail }) => setMkdirName(detail.value)} placeholder="Folder name" />
        </SpaceBetween>
      </Modal>

      <Modal
        visible={newFileOpen}
        onDismiss={() => setNewFileOpen(false)}
        header="New file"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setNewFileOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!newFileName.trim() || !canUpload || busyOp !== null}
                onClick={() => {
                  setNewFileOpen(false);
                  void createEmptyFile(newFileName);
                }}
              >
                Create
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box color="text-body-secondary">Creates an empty file in the current directory.</Box>
          <Input value={newFileName} onChange={({ detail }) => setNewFileName(detail.value)} placeholder="File name" />
        </SpaceBetween>
      </Modal>

      <Modal
        visible={renameOpen}
        onDismiss={() => setRenameOpen(false)}
        header="Rename"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
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
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box color="text-body-secondary">Rename the selected item.</Box>
          <Input value={renameName} onChange={({ detail }) => setRenameName(detail.value)} placeholder="New name" />
        </SpaceBetween>
      </Modal>

      <Modal
        visible={moveOpen}
        onDismiss={() => setMoveOpen(false)}
        header="Move"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setMoveOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
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
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box color="text-body-secondary">
            Enter the full destination path. This can also move across folders/drives.
          </Box>
          <Input value={moveDst} onChange={({ detail }) => setMoveDst(detail.value)} placeholder="C:\\Path\\to\\file" />
        </SpaceBetween>
      </Modal>

      <Modal
        visible={previewOpen}
        onDismiss={() => {
          setPreviewOpen(false);
          setPreviewLoading(false);
          setPreviewText("");
        }}
        size="large"
        header={previewTitle ? `Preview: ${previewTitle}` : "Preview"}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => {
                  setPreviewOpen(false);
                  setPreviewLoading(false);
                  setPreviewText("");
                }}
              >
                Close
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Box
          padding="s"
          nativeAttributes={{
            style: {
              maxHeight: "60vh",
              overflow: "auto",
              border: "1px solid var(--line)",
              borderRadius: 6,
              background: "var(--card-2)",
            },
          }}
        >
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.45,
              color: "var(--tx)",
              padding: 12,
            }}
          >
            {previewLoading ? "Loading…" : previewText || "(Empty file.)"}
          </pre>
        </Box>
      </Modal>

      <Modal
        visible={deleteOpen}
        onDismiss={() => setDeleteOpen(false)}
        header="Delete"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
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
                Delete
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box>
            Delete {selected.length === 1 ? <Box variant="code">{selectedItem?.name ?? ""}</Box> : `${selected.length} items`}?
          </Box>
          <Box color="text-body-secondary">
            Files are permanently deleted. Folders may require recursive delete.
          </Box>
          <Toggle checked={deleteRecursive} onChange={({ detail }) => setDeleteRecursive(detail.checked)}>
            Delete folders recursively
          </Toggle>
        </SpaceBetween>
      </Modal>
      </div>
    </SpaceBetween>
  );
}
