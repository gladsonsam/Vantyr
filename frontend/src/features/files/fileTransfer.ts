// Chunked file transfer over the viewer WebSocket: the agent streams downloads as base64
// `file_chunk` events and accepts uploads as base64 `WriteFileChunk` commands.

/** Raw bytes per upload chunk — must match agent `REMOTE_FILE_CHUNK_BYTES` in `agent/src/main.rs`. */
export const REMOTE_FILE_CHUNK_BYTES = 3 * 1024 * 1024;

/** Base64-encode bytes without spreading the whole buffer into one call (stack limits). */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** Decode one base64 chunk to bytes. Throws on malformed input. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Number of upload chunks for a file (an empty file is still sent as one empty chunk). */
export function uploadChunkCount(size: number, chunkBytes = REMOTE_FILE_CHUNK_BYTES): number {
  return Math.max(1, Math.ceil(size / chunkBytes));
}

/** Byte range `[start, end)` of upload chunk `index`. */
export function uploadChunkRange(
  index: number,
  size: number,
  chunkBytes = REMOTE_FILE_CHUNK_BYTES,
): { start: number; end: number } {
  const start = index * chunkBytes;
  return { start, end: Math.min(start + chunkBytes, size) };
}

/** No fixed wall-clock cap: scale with chunk count (large files need more time). */
export function uploadTimeoutMs(totalChunks: number): number {
  return 30_000 + totalChunks * 2000;
}

export type ChunkProgress =
  | { status: "partial"; percent: number }
  | { status: "complete"; parts: Uint8Array[] };

/**
 * Reassembles downloads that arrive as indexed chunks, possibly out of order. Each chunk is
 * decoded as soon as it arrives rather than concatenating giant base64 strings and decoding
 * once at the end, which is both slow and — for large files — has failed in practice.
 */
export class ChunkAssembler {
  private files = new Map<string, (Uint8Array | null)[]>();

  /** Store a decoded chunk; returns the file's progress, with the ordered parts once complete. */
  add(path: string, index: number, total: number, bytes: Uint8Array): ChunkProgress {
    const chunks = this.files.get(path) ?? new Array<Uint8Array | null>(total).fill(null);
    chunks[index] = bytes;
    this.files.set(path, chunks);
    const received = chunks.filter((chunk) => chunk !== null).length;
    if (received === total) {
      this.files.delete(path);
      return { status: "complete", parts: chunks as Uint8Array[] };
    }
    return { status: "partial", percent: Math.round((received / total) * 100) };
  }

  drop(path: string): void {
    this.files.delete(path);
  }

  clear(): void {
    this.files.clear();
  }
}

/** Trigger a browser download of `parts` named after the last segment of the agent path. */
export function saveDownloadedFile(path: string, parts: Uint8Array[]): void {
  const blob = new Blob(parts as BlobPart[], { type: "application/octet-stream" });
  // A `data:` URI embeds the whole file as base64 in the URL itself, which blows past
  // Chromium's ~2MB URL length cap for anything but tiny files (fails with "Failed to
  // construct 'URL': Invalid URL"). An object URL backed by a Blob has no such limit.
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = path.split("\\").pop() || "file";
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}
