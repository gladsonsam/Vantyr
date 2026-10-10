import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWsBus } from "@/api/wsBus";
import type { WsEvent } from "@/api/types";
import { withWsBus } from "@tests/support/wsBus";
import { uint8ToBase64 } from "@/features/files/fileTransfer";
import { useAgentFs, type FileItem } from "@/features/files/useAgentFs";

const bus = createWsBus();
const send = vi.fn();
const onListing = vi.fn();
let fs: ReturnType<typeof useAgentFs>;
let root: Root;
let host: HTMLDivElement;

function Harness({ enabled = true }: { enabled?: boolean }) {
  const value = useAgentFs({ agentId: "a1", sendWsMessage: send, enabled, onListing });
  useEffect(() => {
    fs = value;
  }, [value]);
  return null;
}

function render(enabled = true) {
  act(() => root.render(withWsBus(<Harness enabled={enabled} />, bus)));
}

function emit(event: WsEvent) {
  act(() => bus.emit(event));
}

const lastCmd = () => send.mock.calls[send.mock.calls.length - 1][0].cmd;
const file = (name: string, size = 10): FileItem => ({ name, is_dir: false, size });
const enc = (text: string) => uint8ToBase64(new TextEncoder().encode(text));

// jsdom's Blob lacks the promise readers; back them with FileReader.
function readBlob(blob: Blob, as: "text" | "buffer"): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    if (as === "text") reader.readAsText(blob);
    else reader.readAsArrayBuffer(blob);
  });
}
if (!Blob.prototype.text) {
  Blob.prototype.text = function () {
    return readBlob(this, "text") as Promise<string>;
  };
}
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return readBlob(this, "buffer") as Promise<ArrayBuffer>;
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  send.mockClear();
  onListing.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function openDocuments(items: FileItem[] = [file("a.txt")]) {
  render();
  emit({ event: "dir_list", agent_id: "a1", data: { path: "C:\\Docs", items } });
  // Locking onto the default folder lists it again by path.
  emit({ event: "dir_list", agent_id: "a1", data: { path: "C:\\Docs", items } });
  onListing.mockClear();
}

describe("useAgentFs listings", () => {
  it("asks for the agent's default folder and locks onto the reply", () => {
    render();
    expect(lastCmd()).toEqual({ type: "ListDir" });
    expect(fs.loading).toBe(true);
    emit({ event: "dir_list", agent_id: "a1", data: { path: "C:\\Docs", items: [file("a.txt")] } });
    expect(fs.currentPath).toBe("C:\\Docs");
    expect(fs.items.map((i) => i.name)).toEqual(["a.txt"]);
    expect(fs.canUpload).toBe(true);
    expect(lastCmd()).toEqual({ type: "ListDir", path: "C:\\Docs" });
    emit({ event: "dir_list", agent_id: "a1", data: { path: "C:\\Docs", items: [file("a.txt")] } });
    expect(fs.loading).toBe(false);
  });

  it("ignores other agents and other folders, and reports listings of the current folder", () => {
    openDocuments();
    emit({ event: "dir_list", agent_id: "other", data: { path: "C:\\Docs", items: [] } });
    emit({ event: "dir_list", agent_id: "a1", data: { path: "C:\\Elsewhere", items: [] } });
    expect(fs.items).toHaveLength(1);
    expect(onListing).not.toHaveBeenCalled();
    emit({ event: "dir_list", agent_id: "a1", data: { path: "c:\\docs", items: [file("b.txt")] } });
    expect(fs.items.map((i) => i.name)).toEqual(["b.txt"]);
    expect(onListing).toHaveBeenCalledWith([file("b.txt")]);
  });

  it("requests nothing when disabled", () => {
    render(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("useAgentFs downloads", () => {
  it("reassembles out-of-order chunks and saves the file", async () => {
    openDocuments();
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:x";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    act(() => fs.download(file("a.txt")));
    expect(lastCmd()).toEqual({ type: "ReadFile", path: "C:\\Docs\\a.txt" });
    expect(fs.downloading).toBe("C:\\Docs\\a.txt");

    const chunk = (index: number, text: string) =>
      emit({
        event: "file_chunk",
        agent_id: "a1",
        data: { path: "C:\\Docs\\a.txt", chunk_index: index, total_chunks: 2, data: enc(text) },
      });
    chunk(1, "world");
    expect(fs.downloadProgress).toBe(50);
    await act(async () => {
      bus.emit({
        event: "file_chunk",
        agent_id: "a1",
        data: { path: "C:\\Docs\\a.txt", chunk_index: 0, total_chunks: 2, data: enc("hello ") },
      });
    });

    expect(click).toHaveBeenCalledTimes(1);
    expect(await created[0].text()).toBe("hello world");
    expect(fs.downloading).toBeNull();
  });

  it("shows a finished download in the preview instead of saving it", async () => {
    openDocuments();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    act(() => fs.openPreview(file("a.txt")));
    expect(fs.preview).toMatchObject({ open: true, title: "a.txt", loading: true });
    await act(async () => {
      bus.emit({
        event: "file_chunk",
        agent_id: "a1",
        data: { path: "C:\\Docs\\a.txt", chunk_index: 0, total_chunks: 1, data: enc("preview me") },
      });
    });
    await act(async () => {});
    expect(fs.preview).toMatchObject({ open: true, text: "preview me", loading: false });
    expect(click).not.toHaveBeenCalled();
  });

  it("reports agent errors and corrupt chunks", () => {
    openDocuments();
    act(() => fs.download(file("a.txt")));
    emit({ event: "file_chunk", agent_id: "a1", data: { is_error: true, data: "Access denied" } });
    expect(fs.fsMessage).toEqual({ ok: false, text: "Access denied" });
    expect(fs.downloading).toBeNull();

    act(() => fs.download(file("a.txt")));
    emit({
      event: "file_chunk",
      agent_id: "a1",
      data: { path: "C:\\Docs\\a.txt", chunk_index: 0, total_chunks: 2, data: "%%%" },
    });
    expect(fs.fsMessage).toEqual({ ok: false, text: 'Received a corrupt chunk for "a.txt".' });
  });

  it("gives up after the agent goes quiet", () => {
    vi.useFakeTimers();
    openDocuments();
    act(() => fs.download(file("a.txt")));
    act(() => vi.advanceTimersByTime(20_000));
    expect(fs.fsMessage).toEqual({ ok: false, text: "Download timed out." });
    expect(fs.downloading).toBeNull();
  });
});

describe("useAgentFs operations", () => {
  it("resolves a file operation by request id and reloads the folder", async () => {
    openDocuments();
    let outcome: Promise<{ ok: boolean }> | undefined;
    act(() => {
      outcome = fs.runFsOp({ type: "Mkdir", path: "C:\\Docs", name: "New" }, "Create folder");
    });
    const cmd = lastCmd();
    expect(cmd).toMatchObject({ type: "Mkdir", name: "New" });
    expect(fs.busyOp).toBe("Create folder");
    emit({ event: "fs_op_result", agent_id: "a1", data: { request_id: "someone else", ok: false } });
    expect(fs.busyOp).toBe("Create folder");
    await act(async () => {
      bus.emit({ event: "fs_op_result", agent_id: "a1", data: { request_id: cmd.request_id, ok: true } });
      await outcome;
    });
    expect(fs.busyOp).toBeNull();
    expect(fs.fsMessage).toEqual({ ok: true, text: "Create folder completed." });
    expect(lastCmd()).toEqual({ type: "ListDir", path: "C:\\Docs" });
  });

  it("uploads a file as base64 chunks and waits for the agent's result", async () => {
    openDocuments();
    const upload = new File(["hi there"], "up.txt");
    let done: Promise<void> | undefined;
    await act(async () => {
      done = fs.uploadFiles([upload]);
      // Reading the file slice is asynchronous; wait until the chunk has been sent.
      for (let i = 0; i < 100 && lastCmd().type !== "WriteFileChunk"; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
    });
    expect(lastCmd()).toEqual({
      type: "WriteFileChunk",
      path: "C:\\Docs\\up.txt",
      chunk_index: 0,
      total_chunks: 1,
      data: enc("hi there"),
    });
    expect(fs.uploading).toBe("C:\\Docs\\up.txt");
    await act(async () => {
      bus.emit({ event: "file_upload_result", agent_id: "a1", data: { path: "c:\\docs\\UP.txt", ok: true } });
      await done;
    });
    expect(fs.uploadMessage).toBe("Upload finished.");
    expect(fs.uploading).toBeNull();
  });
});
