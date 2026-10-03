/** Pure bounded MJPEG/JPEG parsing. No fetch, decoding, DOM or input side effects. */
export interface DesktopRect {
  x: number;
  y: number;
  physical_width: number;
  physical_height: number;
}
export interface CaptureGeometry {
  capture_id: string;
  geometry_revision: number;
  monitor_index: number | null;
  desktop: DesktopRect | null;
  frame_width: number;
  frame_height: number;
}
export interface GeometryOptions {
  /** Null desktop metadata is informational only; it cannot authorize mapped mouse input. */
  allowNullDesktop?: boolean;
  decodedDimensions?: { width: number; height: number };
  maxMetadataBytes?: number;
}
export interface RemoteFrame { jpeg: Uint8Array; geometry: CaptureGeometry | null }
const signature = new TextEncoder().encode("VantyrGeometry\0");
const safe = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const uint = (v: unknown, min = 0): v is number => safe(v) && v >= min && v <= 0xffffffff;
const signed = (v: unknown): v is number => safe(v) && v >= -0x80000000 && v <= 0x7fffffff;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function validateGeometry(value: unknown, options: GeometryOptions): CaptureGeometry | null {
  if (!object(value) || value.type !== "capture_geometry" || value.schema_version !== 1 || !object(value.geometry)) return null;
  const g = value.geometry;
  if (typeof g.capture_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(g.capture_id)
    || !safe(g.geometry_revision) || g.geometry_revision <= 0
    || !(g.monitor_index === null || (safe(g.monitor_index) && g.monitor_index >= 0))
    || !uint(g.frame_width, 1) || !uint(g.frame_height, 1)) return null;
  let desktop: DesktopRect | null = null;
  if (g.desktop === null) {
    if (!options.allowNullDesktop) return null;
  } else {
    const r = g.desktop;
    if (!object(r) || !signed(r.x) || !signed(r.y) || !uint(r.physical_width, 1) || !uint(r.physical_height, 1)
      || !signed(r.x + r.physical_width - 1) || !signed(r.y + r.physical_height - 1)) return null;
    desktop = { x: r.x, y: r.y, physical_width: r.physical_width, physical_height: r.physical_height };
  }
  const d = options.decodedDimensions;
  if (d && (!uint(d.width, 1) || !uint(d.height, 1) || d.width !== g.frame_width || d.height !== g.frame_height)) return null;
  return { capture_id: g.capture_id, geometry_revision: g.geometry_revision, monitor_index: g.monitor_index,
    desktop, frame_width: g.frame_width, frame_height: g.frame_height };
}

// Schema 1 has globally distinct field names. Reject duplicate JSON properties,
// including escaped spellings, instead of silently trusting JSON.parse's last value.
function uniqueMetadataKeys(json: string): boolean {
  const keys = new Set<string>();
  for (let i = 0; i < json.length; i++) {
    if (json[i] !== '"') continue;
    const start = i++;
    while (i < json.length && json[i] !== '"') { if (json[i] === "\\") i++; i++; }
    if (i === json.length) return false;
    let next = i + 1;
    while (/\s/.test(json[next] ?? "") && next < json.length) next++;
    if (json[next] === ":") {
      const key: unknown = JSON.parse(json.slice(start, i + 1));
      if (typeof key !== "string" || keys.has(key)) return false;
      keys.add(key);
    }
  }
  return true;
}

/** Tracks true JPEG EOI, skipping length-delimited segments and entropy stuffing.
 * Boundary-like bytes (including FF D9) inside APP/COM segments are data. */
class JpegScanner {
  private phase: "soiFF" | "soiD8" | "markerFF" | "marker" | "lengthHi" | "lengthLo" | "segment" | "entropy" | "entropyFF" = "soiFF";
  private marker = 0;
  private remaining = 0;
  done = false;
  hasSof = false;
  hasScan = false;
  byte(b: number): void {
    if (this.done) throw new Error("Bytes after JPEG EOI");
    switch (this.phase) {
      case "soiFF": if (b !== 0xff) throw new Error("Missing JPEG SOI"); this.phase = "soiD8"; break;
      case "soiD8": if (b !== 0xd8) throw new Error("Missing JPEG SOI"); this.phase = "markerFF"; break;
      case "markerFF": if (b !== 0xff) throw new Error("Invalid JPEG marker"); this.phase = "marker"; break;
      case "entropy": if (b === 0xff) this.phase = "entropyFF"; break;
      case "entropyFF":
        if (b === 0 || (b >= 0xd0 && b <= 0xd7)) { this.phase = "entropy"; break; }
        if (b === 0xff) break;
        this.readMarker(b); break;
      case "marker": if (b !== 0xff) this.readMarker(b); break;
      case "lengthHi": this.remaining = b * 256; this.phase = "lengthLo"; break;
      case "lengthLo":
        this.remaining += b;
        if (this.remaining < 2) throw new Error("Invalid JPEG segment length");
        this.remaining -= 2;
        this.phase = this.remaining ? "segment" : (this.marker === 0xda ? "entropy" : "markerFF"); break;
      case "segment":
        if (--this.remaining === 0) this.phase = this.marker === 0xda ? "entropy" : "markerFF";
        break;
    }
  }
  private readMarker(b: number): void {
    if (b === 0xd9) { this.done = true; return; }
    if (b === 0 || b === 0xd8 || b < 0xc0 && b !== 1) throw new Error("Invalid JPEG marker");
    if (b === 1 || (b >= 0xd0 && b <= 0xd7)) { this.phase = "markerFF"; return; }
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(b)) this.hasSof = true;
    if (b === 0xda) this.hasScan = true;
    this.marker = b; this.phase = "lengthHi";
  }
}

/** Invalid/missing/duplicate metadata returns null, never inferred coordinates.
 * This is structural validation, not cryptographic authentication or a JPEG decoder. */
export function parseJpegGeometry(jpeg: Uint8Array, options: GeometryOptions = {}): CaptureGeometry | null {
  try {
    const scanner = new JpegScanner();
    for (const b of jpeg) scanner.byte(b);
    if (!scanner.done || !scanner.hasSof || !scanner.hasScan) return null;
    let found = 0;
    let geometry: CaptureGeometry | null = null;
    let dimensions: { width: number; height: number } | undefined;
    let entropy = false;
    for (let p = 2; p < jpeg.length;) {
      if (entropy) {
        if (jpeg[p++] !== 0xff) continue;
        while (jpeg[p] === 0xff) p++;
        if (jpeg[p] === 0 || jpeg[p] >= 0xd0 && jpeg[p] <= 0xd7) { p++; continue; }
      } else {
        p++; // scanner already validated FF
        while (jpeg[p] === 0xff) p++;
      }
      const marker = jpeg[p++];
      if (marker === 0xd9) break;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = jpeg[p] * 256 + jpeg[p + 1];
      const start = p + 2, end = p + length;
      if (marker === 0xef && end - start >= signature.length && signature.every((b, i) => jpeg[start + i] === b)) {
        found++;
        if (end - start - signature.length <= (options.maxMetadataBytes ?? 4096)) {
          try {
            const json = new TextDecoder("utf-8", { fatal: true }).decode(jpeg.subarray(start + signature.length, end));
            // Reject fractional/exponent/duplicate revision tokens before JSON
            // floating-point parsing can round them into a safe-looking integer.
            const revisions = [...json.matchAll(/"geometry_revision"\s*:\s*([0-9]+)(?=\s*[,}])/g)];
            geometry = revisions.length === 1 && uniqueMetadataKeys(json) ? validateGeometry(JSON.parse(json), options) : null;
          } catch { geometry = null; }
        } else geometry = null;
      }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || dimensions) return null;
        dimensions = { height: jpeg[start + 1] * 256 + jpeg[start + 2], width: jpeg[start + 3] * 256 + jpeg[start + 4] };
      }
      p = end;
      entropy = marker === 0xda;
    }
    if (found !== 1 || !geometry) return null;
    if (dimensions && (dimensions.width !== geometry.frame_width || dimensions.height !== geometry.frame_height)) return null;
    return geometry;
  } catch { return null; }
}

export function multipartBoundary(contentType: string): string {
  if (contentType.length > 1024) throw new Error("Content-Type too long");
  const parts = contentType.match(/(?:[^;"\r\n]|"[^"\r\n]*")+/g);
  if (!parts || parts.join(";") !== contentType || parts[0].trim().toLowerCase() !== "multipart/x-mixed-replace") throw new Error("Invalid MJPEG Content-Type");
  let boundary: string | undefined;
  for (const part of parts.slice(1)) {
    const match = /^\s*([^=\s]+)\s*=\s*(?:"([^"]*)"|([^"\s]+))\s*$/.exec(part);
    if (!match) throw new Error("Invalid multipart parameter");
    if (match[1].toLowerCase() !== "boundary") continue;
    if (boundary !== undefined) throw new Error("Duplicate boundary");
    boundary = match[2] ?? match[3];
  }
  if (!boundary || !/^[0-9a-z'()+_,\-./:=? ]{1,70}$/i.test(boundary) || boundary.endsWith(" ")) throw new Error("Invalid multipart boundary");
  return boundary;
}
export interface MultipartOptions extends GeometryOptions {
  maxHeaderBytes?: number;
  maxFrameBytes?: number;
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
  /** Existing server may EOF after a complete JPEG + CRLF without a closing boundary. */
  allowEofAfterPart?: boolean;
}

/** push/takeFrame are synchronous: drain between chunks. Queue overflow fails
 * closed (clears all owned buffers); caller must cancel its reader on errors.
 * Byte buffers <= 2*maxFrameBytes + maxHeaderBytes + maxQueuedBytes, including
 * transient body growth/copies. Strings/metadata have bounded size and count;
 * the caller's input chunk is not retained. */
export class MultipartJpegParser {
  private readonly delimiter: Uint8Array;
  private readonly first: Uint8Array;
  private readonly maxHeader: number;
  private readonly maxFrame: number;
  private readonly maxQueue: number;
  private readonly maxQueueBytes: number;
  private state: "first" | "suffix" | "headers" | "body" | "delimiter" | "closing" | "closed" | "failed" | "cancelled" = "first";
  private pos = 0;
  private suffix = "";
  private headers = new Uint8Array(0);
  private headerSize = 0;
  private body = new Uint8Array(0);
  private size = 0;
  private length: number | null = null;
  private scanner = new JpegScanner();
  private queue: RemoteFrame[] = [];
  private queueBytes = 0;
  constructor(contentType: string, private readonly options: MultipartOptions = {}) {
    const b = multipartBoundary(contentType);
    this.first = new TextEncoder().encode(`--${b}`);
    this.delimiter = new TextEncoder().encode(`\r\n--${b}`);
    function limit(v: number | undefined, fallback: number): number {
      const n = v ?? fallback;
      if (!Number.isSafeInteger(n) || n < 1 || n > 0x40000000) throw new Error("Invalid parser limit");
      return n;
    }
    this.maxHeader = limit(options.maxHeaderBytes, 8192);
    if (this.maxHeader > 65536) throw new Error("Header limit exceeds 64 KiB");
    this.headers = new Uint8Array(this.maxHeader);
    this.maxFrame = limit(options.maxFrameBytes, 8 * 1024 * 1024);
    this.maxQueue = limit(options.maxQueuedFrames, 4);
    this.maxQueueBytes = limit(options.maxQueuedBytes, 16 * 1024 * 1024);
  }
  get queuedFrames(): number { return this.queue.length; }
  get bufferedBytes(): number { return this.body.byteLength + this.headers.byteLength + this.queueBytes; }
  get closed(): boolean { return this.state === "closed"; }
  takeFrame(): RemoteFrame | undefined {
    const frame = this.queue.shift(); if (frame) this.queueBytes -= frame.jpeg.length; return frame;
  }
  cancel(): void { this.clear(); this.state = "cancelled"; }
  finish(): void {
    if (this.state === "closed") return;
    // MIME closing delimiter may end at EOF without its optional final CRLF.
    if (this.state === "closing" && this.pos === 0) { this.state = "closed"; this.body = new Uint8Array(0); this.headers = new Uint8Array(0); return; }
    if (this.options.allowEofAfterPart && this.state === "delimiter" && this.pos === 2) { this.state = "closed"; this.body = new Uint8Array(0); this.headers = new Uint8Array(0); return; }
    this.fail("Truncated multipart stream");
  }
  push(chunk: Uint8Array): void {
    if (this.state === "failed" || this.state === "cancelled") throw new Error("Parser is inactive");
    try { for (const b of chunk) this.byte(b); }
    catch (e) { this.clear(); this.state = "failed"; throw e; }
  }
  private clear(): void { this.queue = []; this.queueBytes = 0; this.body = new Uint8Array(0); this.headers = new Uint8Array(0); this.headerSize = 0; this.size = 0; }
  private fail(message: string): never { this.clear(); this.state = "failed"; throw new Error(message); }
  private byte(b: number): void {
    switch (this.state) {
      case "first": case "delimiter": {
        const token = this.state === "first" ? this.first : this.delimiter;
        if (b !== token[this.pos++]) this.fail("Invalid multipart delimiter");
        if (this.pos === token.length) { this.pos = 0; this.suffix = ""; this.state = "suffix"; }
        break;
      }
      case "suffix":
        this.suffix += String.fromCharCode(b);
        if (this.suffix.length === 1 && b !== 13 && b !== 45) this.fail("Invalid boundary suffix");
        if (this.suffix.length === 2) {
          if (this.suffix === "\r\n") { this.state = "headers"; this.headerSize = 0; }
          else if (this.suffix === "--") { this.state = "closing"; this.pos = 0; }
          else this.fail("Invalid boundary suffix");
        }
        break;
      case "closing":
        if (b !== [13, 10][this.pos++]) this.fail("Invalid closing boundary");
        if (this.pos === 2) { this.state = "closed"; this.body = new Uint8Array(0); this.headers = new Uint8Array(0); }
        break;
      case "closed": this.fail("Bytes after closing boundary"); break;
      case "headers": {
        if (this.headerSize >= this.maxHeader) this.fail("Multipart headers too large");
        this.headers[this.headerSize++] = b;
        const n = this.headerSize;
        if (n === 2 && this.headers[0] === 13 && b === 10 || n >= 4 && this.headers[n - 4] === 13 && this.headers[n - 3] === 10 && this.headers[n - 2] === 13 && b === 10) this.startBody();
        break;
      }
      case "body":
        if (this.size >= this.maxFrame) this.fail("JPEG frame too large");
        if (this.size === this.body.length) {
          const bigger = new Uint8Array(Math.min(this.maxFrame, Math.max(1024, this.body.length * 2)));
          bigger.set(this.body); this.body = bigger;
        }
        this.body[this.size++] = b; this.scanner.byte(b);
        if (this.length !== null ? this.size === this.length : this.scanner.done) this.endBody();
        break;
      default: this.fail("Parser is inactive");
    }
  }
  private startBody(): void {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(this.headers.subarray(0, this.headerSize));
    const seen = new Set<string>(); this.length = null;
    const content = text === "\r\n" ? "" : text.slice(0, -4);
    for (const line of content ? content.split("\r\n") : []) {
      const match = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/.exec(line);
      if (!match || [...line].some(c => c.charCodeAt(0) === 127 || c.charCodeAt(0) < 32 && c !== "\t")) this.fail("Invalid multipart header");
      const key = match[1].toLowerCase(), value = match[2].trim();
      if (seen.has(key)) this.fail("Duplicate multipart header"); seen.add(key);
      if (key === "content-type" && value.toLowerCase() !== "image/jpeg") this.fail("Unsupported part type");
      if (key === "content-length") {
        if (!/^[0-9]+$/.test(value)) this.fail("Invalid Content-Length");
        const length = Number(value);
        if (!Number.isSafeInteger(length) || length < 4 || length > this.maxFrame) this.fail("Content-Length exceeds frame limit");
        this.length = length;
      }
      if (key === "transfer-encoding") this.fail("Unsupported part transfer encoding");
    }
    this.headerSize = 0; this.size = 0; this.scanner = new JpegScanner(); this.state = "body";
  }
  private endBody(): void {
    if (!this.scanner.done || !this.scanner.hasSof || !this.scanner.hasScan) this.fail("Truncated or invalid JPEG body");
    if (this.queue.length >= this.maxQueue || this.queueBytes + this.size > this.maxQueueBytes) this.fail("Frame queue limit exceeded; drain between chunks");
    const jpeg = this.body.slice(0, this.size);
    this.queue.push({ jpeg, geometry: parseJpegGeometry(jpeg, this.options) }); this.queueBytes += jpeg.length;
    this.size = 0; this.state = "delimiter"; this.pos = 0;
  }
}
