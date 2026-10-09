import { describe, expect, it } from "vitest";
import {
  ChunkAssembler,
  REMOTE_FILE_CHUNK_BYTES,
  base64ToBytes,
  uint8ToBase64,
  uploadChunkCount,
  uploadChunkRange,
  uploadTimeoutMs,
} from "@/features/files/fileTransfer";

const bytes = (...xs: number[]) => Uint8Array.from(xs);

describe("base64 round trip", () => {
  it("encodes and decodes arbitrary bytes", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(uint8ToBase64(all))).toEqual(all);
  });

  it("handles buffers larger than one encode step", () => {
    const big = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 7) % 256);
    const b64 = uint8ToBase64(big);
    expect(b64).toHaveLength(4 * Math.ceil(big.length / 3));
    expect(base64ToBytes(b64)).toEqual(big);
  });

  it("matches the standard alphabet and padding", () => {
    expect(uint8ToBase64(bytes(77, 97, 110))).toBe("TWFu");
    expect(uint8ToBase64(bytes(77, 97))).toBe("TWE=");
    expect(uint8ToBase64(bytes(255, 254, 253))).toBe("//79");
  });

  it("encodes an empty buffer as an empty string", () => {
    expect(uint8ToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  it("rejects malformed base64", () => {
    expect(() => base64ToBytes("not base64!")).toThrow();
  });
});

describe("upload chunking", () => {
  it("always sends at least one chunk", () => {
    expect(uploadChunkCount(0)).toBe(1);
    expect(uploadChunkCount(1)).toBe(1);
    expect(uploadChunkCount(REMOTE_FILE_CHUNK_BYTES)).toBe(1);
    expect(uploadChunkCount(REMOTE_FILE_CHUNK_BYTES + 1)).toBe(2);
  });

  it("splits a file into contiguous ranges that cover every byte", () => {
    const size = 10;
    const chunk = 4;
    const count = uploadChunkCount(size, chunk);
    const ranges = Array.from({ length: count }, (_, i) => uploadChunkRange(i, size, chunk));
    expect(ranges).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
      { start: 8, end: 10 },
    ]);
  });

  it("scales the upload timeout with the chunk count", () => {
    expect(uploadTimeoutMs(1)).toBe(32_000);
    expect(uploadTimeoutMs(10)).toBe(50_000);
  });
});

describe("ChunkAssembler", () => {
  it("reports progress and returns parts in index order once complete", () => {
    const asm = new ChunkAssembler();
    expect(asm.add("C:\\a.bin", 2, 3, bytes(5, 6))).toEqual({ status: "partial", percent: 33 });
    expect(asm.add("C:\\a.bin", 0, 3, bytes(1, 2))).toEqual({ status: "partial", percent: 67 });
    const done = asm.add("C:\\a.bin", 1, 3, bytes(3, 4));
    expect(done.status).toBe("complete");
    expect(done.status === "complete" && done.parts).toEqual([bytes(1, 2), bytes(3, 4), bytes(5, 6)]);
  });

  it("counts a repeated chunk once", () => {
    const asm = new ChunkAssembler();
    asm.add("f", 0, 2, bytes(1));
    expect(asm.add("f", 0, 2, bytes(1))).toEqual({ status: "partial", percent: 50 });
  });

  it("tracks files independently and forgets dropped or completed ones", () => {
    const asm = new ChunkAssembler();
    asm.add("a", 0, 2, bytes(1));
    asm.add("b", 0, 2, bytes(9));
    asm.drop("a");
    // "a" starts over after a drop.
    expect(asm.add("a", 1, 2, bytes(2))).toEqual({ status: "partial", percent: 50 });
    expect(asm.add("b", 1, 2, bytes(8)).status).toBe("complete");
    // A completed file is forgotten, so a re-download starts from scratch.
    expect(asm.add("b", 0, 2, bytes(9))).toEqual({ status: "partial", percent: 50 });
    asm.clear();
    expect(asm.add("a", 0, 2, bytes(1))).toEqual({ status: "partial", percent: 50 });
  });

  it("completes a single-chunk file immediately", () => {
    const asm = new ChunkAssembler();
    expect(asm.add("one", 0, 1, bytes(42))).toEqual({ status: "complete", parts: [bytes(42)] });
  });
});
