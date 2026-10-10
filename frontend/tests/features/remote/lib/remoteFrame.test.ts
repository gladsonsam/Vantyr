import { describe, expect, it } from "vitest";
import { MultipartJpegParser, multipartBoundary, parseJpegGeometry, type CaptureGeometry } from "@/features/remote/lib/remoteFrame";
const encode = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const p of parts) { result.set(p, offset); offset += p.length; } return result;
};
// Real baseline 16x24 RGB JPEG, generated with Pillow quality=40.
const baseline = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAAYABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEooorpOUKKKKAP//Z"), c => c.charCodeAt(0));
const geometry: CaptureGeometry = { capture_id: "5e6334d6-9b8f-4dc5-8ef0-b3ff5c53126b", geometry_revision: 17,
  monitor_index: 1, desktop: { x: -1080, y: -200, physical_width: 1080, physical_height: 1920 }, frame_width: 16, frame_height: 24 };
const wire = (g: unknown = geometry) => ({ type: "capture_geometry", schema_version: 1, geometry: g });
function segment(payload: Uint8Array, marker = 0xef): Uint8Array {
  const n = payload.length + 2; return concat(new Uint8Array([0xff, marker, n >> 8, n & 255]), payload);
}
const marker = (value: unknown = wire()) => segment(concat(encode("VantyrGeometry\0"), encode(JSON.stringify(value))));
const jpeg = (...markers: Uint8Array[]) => concat(baseline.subarray(0, 2), ...markers, baseline.subarray(2));
const fixture = jpeg(marker());
const contentType = 'multipart/x-mixed-replace; boundary="frame"';
function part(image: Uint8Array, length = true, extra = ""): Uint8Array {
  return concat(encode(`--frame\r\nContent-Type: image/jpeg\r\n${length ? `Content-Length: ${image.length}\r\n` : ""}${extra}\r\n`), image, encode("\r\n"));
}
const close = encode("--frame--\r\n");
const parser = (options = {}) => new MultipartJpegParser(contentType, { maxFrameBytes: 4096, ...options });

describe("agent JPEG APP15 geometry", () => {
  it("reads the agent schema and checks actual JPEG and decoded dimensions", () => {
    expect(parseJpegGeometry(fixture)).toEqual(geometry);
    expect(parseJpegGeometry(fixture, { decodedDimensions: { width: 16, height: 24 } })).toEqual(geometry);
    expect(parseJpegGeometry(fixture, { decodedDimensions: { width: 24, height: 16 } })).toBeNull();
    expect(parseJpegGeometry(jpeg(marker(wire({ ...geometry, frame_width: 15 }))))).toBeNull();
    expect(parseJpegGeometry(baseline)).toBeNull();
  });
  it("rejects duplicate, malformed, oversized, invalid UTF8 and truncated markers", () => {
    expect(parseJpegGeometry(jpeg(marker(), marker()))).toBeNull();
    expect(parseJpegGeometry(jpeg(marker(), marker({ type: "bad" })))).toBeNull();
    expect(parseJpegGeometry(jpeg(segment(encode("VantyrGeometry\0{bad"))))).toBeNull();
    expect(parseJpegGeometry(jpeg(segment(concat(encode("VantyrGeometry\0"), new Uint8Array([0xff])))))).toBeNull();
    expect(parseJpegGeometry(fixture, { maxMetadataBytes: 3 })).toBeNull();
    for (let n = 0; n < fixture.length; n++) expect(parseJpegGeometry(fixture.subarray(0, n))).toBeNull();
    expect(parseJpegGeometry(concat(fixture, encode("garbage")))).toBeNull();
    const broken = fixture.slice(); broken[4] = 0; broken[5] = 1; expect(parseJpegGeometry(broken)).toBeNull();
  });
  it("validates UUID, u64 safe precision, dimensions and signed rectangle overflow", () => {
    for (const change of [
      { capture_id: "invalid" }, { capture_id: `${geometry.capture_id} ` }, { capture_id: "00000000-0000-0000-0000-000000000000" },
      { geometry_revision: 0 }, { geometry_revision: -1 }, { geometry_revision: 1.5 }, { geometry_revision: "17" },
      { geometry_revision: Number.MAX_SAFE_INTEGER + 1 }, { monitor_index: -1 }, { monitor_index: 1.1 },
      { frame_width: 0 }, { frame_height: 0 }, { frame_width: 0x100000000 }, { frame_width: 16.5 },
      { desktop: { ...geometry.desktop, x: -0x80000001 } }, { desktop: { ...geometry.desktop, x: 0x7fffffff } },
      { desktop: { ...geometry.desktop, y: 0x7fffffff } }, { desktop: { ...geometry.desktop, physical_width: 0 } },
      { desktop: { ...geometry.desktop, physical_height: 1.5 } }, { desktop: {} }, { desktop: undefined },
    ]) expect(parseJpegGeometry(jpeg(marker(wire({ ...geometry, ...change }))))).toBeNull();
    expect(parseJpegGeometry(jpeg(marker(wire({ ...geometry, geometry_revision: Number.MAX_SAFE_INTEGER }))))?.geometry_revision).toBe(Number.MAX_SAFE_INTEGER);
    const duplicate = JSON.stringify(wire()).replace('"geometry_revision":17', '"geometry_revision":17,"geometry_revision":1.7e1');
    expect(parseJpegGeometry(jpeg(segment(concat(encode("VantyrGeometry\0"), encode(duplicate)))))).toBeNull();
    const escapedDuplicate = JSON.stringify(wire()).replace('"geometry_revision":17', '"geometry_revision":17,"geometry_\\u0072evision":18');
    expect(parseJpegGeometry(jpeg(segment(concat(encode("VantyrGeometry\0"), encode(escapedDuplicate)))))).toBeNull();
    const u64 = JSON.stringify(wire()).replace('"geometry_revision":17', '"geometry_revision":18446744073709551615');
    expect(parseJpegGeometry(jpeg(segment(concat(encode("VantyrGeometry\0"), encode(u64)))))).toBeNull();
    expect(parseJpegGeometry(jpeg(marker({ ...wire(), schema_version: 2 })))).toBeNull();
    for (const token of ["17.000000000000000001", "1.7e1", "9007199254740991.1"]) {
      const raw = JSON.stringify(wire()).replace('"geometry_revision":17', `"geometry_revision":${token}`);
      expect(parseJpegGeometry(jpeg(segment(concat(encode("VantyrGeometry\0"), encode(raw)))))).toBeNull();
    }
  });
  it("permits null desktop only with explicit informational opt-in", () => {
    const unknown = { ...geometry, monitor_index: null, desktop: null }; const image = jpeg(marker(wire(unknown)));
    expect(parseJpegGeometry(image)).toBeNull(); expect(parseJpegGeometry(image, { allowNullDesktop: true })).toEqual(unknown);
  });
  it("skips fake geometry and EOI inside unrelated binary segments", () => {
    const decoy = segment(concat(encode("\r\n--frame\r\n"), new Uint8Array([0xff, 0xd9]), marker()), 0xfe);
    expect(parseJpegGeometry(jpeg(decoy, marker()))).toEqual(geometry);
  });
});

describe("bounded incremental MJPEG", () => {
  it("validates quoted boundaries and rejects duplicates and injection", () => {
    expect(multipartBoundary(contentType)).toBe("frame");
    expect(multipartBoundary('Multipart/X-Mixed-Replace; foo=bar; boundary="a b"')).toBe("a b");
    for (const value of ["image/jpeg", "multipart/x-mixed-replace", "multipart/x-mixed-replace; boundary=", "multipart/x-mixed-replace; boundary=x; boundary=y", "multipart/x-mixed-replace; boundary=x\r\nOops: y", `multipart/x-mixed-replace; boundary=${"x".repeat(71)}`, 'multipart/x-mixed-replace; boundary="x "', 'multipart/x-mixed-replace; boundary="a\\b"']) expect(() => multipartBoundary(value)).toThrow();
  });
  it.each([true, false])("handles every split point, Content-Length=%s", length => {
    const stream = concat(part(fixture, length), part(baseline, !length), close);
    for (let n = 0; n <= stream.length; n++) {
      const p = parser(); p.push(stream.subarray(0, n)); p.push(stream.subarray(n)); p.finish();
      expect(p.closed).toBe(true);
      const first = p.takeFrame(), second = p.takeFrame();
      expect(first?.jpeg.length === fixture.length && first.jpeg.every((b, i) => b === fixture[i])).toBe(true);
      expect(first?.geometry).toEqual(geometry);
      expect(second?.jpeg.length === baseline.length && second.jpeg.every((b, i) => b === baseline[i])).toBe(true);
      expect(second?.geometry).toBeNull(); expect(p.takeFrame()).toBeUndefined();
    }
  });
  it("handles one-byte chunks and binary boundary malice without Content-Length", () => {
    const decoy = segment(concat(encode("\r\n--frame\r\nContent-Length: 3\r\n\r\n"), new Uint8Array([0xff, 0xd9])), 0xfe);
    const image = jpeg(decoy, marker()); const p = parser();
    for (const b of concat(part(image, false), close)) p.push(new Uint8Array([b]));
    p.finish(); expect(p.takeFrame()).toEqual({ jpeg: image, geometry });
    const falseEnd = concat(baseline.subarray(0, baseline.length - 2), new Uint8Array([0xff, 0, 0xd9]), encode("\r\n--frame--\r\n"), baseline.subarray(-2));
    const q = parser(); q.push(concat(part(falseEnd, false), close)); q.finish(); expect(q.takeFrame()?.jpeg).toEqual(falseEnd);
  });
  it("fails closed on bad headers, lengths, JPEG, delimiters and trailing data", () => {
    for (const bytes of [part(fixture, true, "Content-Length: 4\r\n"), part(fixture, false, "Content-Length: -1\r\n"),
      part(fixture, false, "Content-Length: 18446744073709551615\r\n"), part(fixture, false, "Content-Length: 4.5\r\n"),
      part(fixture, false, "Bad Header\r\n"), part(fixture, false, "Transfer-Encoding: chunked\r\n"),
      part(encode("not jpeg")), part(fixture.subarray(0, fixture.length - 2)),
      concat(part(fixture), encode("--wrong--\r\n")), concat(part(fixture), close, encode("x"))]) {
      const p = parser(); expect(() => { p.push(bytes); p.finish(); }).toThrow(); expect(p.bufferedBytes).toBe(0);
      expect(p.takeFrame()).toBeUndefined(); expect(() => p.push(close)).toThrow();
    }
    expect(() => parser().push(concat(part(fixture, false, `Content-Length: ${fixture.length + 1}\r\n`), close))).toThrow();
  });
  it("bounds headers, frames, queued bytes and backpressure", () => {
    for (const [options, bytes] of [
      [{ maxHeaderBytes: 8 }, part(fixture)], [{ maxFrameBytes: 32 }, part(fixture)],
      [{ maxFrameBytes: 32 }, part(fixture, false)], [{ maxQueuedBytes: 32 }, part(fixture)],
      [{ maxQueuedFrames: 1 }, concat(part(fixture), part(fixture))],
    ] as const) { const p = parser(options); expect(() => p.push(bytes)).toThrow(); expect(p.bufferedBytes).toBe(0); }
    const p = parser({ maxQueuedFrames: 1 });
    for (let i = 0; i < 50; i++) { p.push(part(fixture)); expect(p.queuedFrames).toBe(1); expect(p.bufferedBytes).toBeLessThanOrEqual(8192 + 4096 + fixture.length); expect(p.takeFrame()?.geometry).toEqual(geometry); }
    p.push(close); p.finish(); expect(p.bufferedBytes).toBe(0);
    for (const limit of [0, -1, NaN, Infinity, 1.5, 0x40000001]) expect(() => parser({ maxFrameBytes: limit })).toThrow();
  });
  it("requires closure or explicit EOF-after-complete-part compatibility", () => {
    const p = parser(); p.push(part(fixture)); expect(() => p.finish()).toThrow(); expect(p.queuedFrames).toBe(0);
    const q = parser({ allowEofAfterPart: true }); q.push(part(fixture)); q.finish(); expect(q.closed).toBe(true); expect(q.takeFrame()?.geometry).toEqual(geometry);
    const r = parser({ allowEofAfterPart: true }); r.push(part(fixture).subarray(0, part(fixture).length - 1)); expect(() => r.finish()).toThrow();
    const empty = parser(); empty.push(close); empty.finish(); expect(empty.takeFrame()).toBeUndefined();
    const noCrlf = parser(); noCrlf.push(concat(part(fixture), encode("--frame--"))); noCrlf.finish(); expect(noCrlf.closed).toBe(true);
    const noHeaders = parser(); noHeaders.push(concat(encode("--frame\r\n\r\n"), fixture, encode("\r\n"), close)); noHeaders.finish(); expect(noHeaders.takeFrame()?.geometry).toEqual(geometry);
  });
  it("clears all memory on explicit cancellation and forbids reuse", () => {
    const p = parser(); p.push(part(fixture)); p.cancel(); expect(p.bufferedBytes).toBe(0); expect(p.takeFrame()).toBeUndefined(); expect(() => p.push(close)).toThrow();
  });
});
