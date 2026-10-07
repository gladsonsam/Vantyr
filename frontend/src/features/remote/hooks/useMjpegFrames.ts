import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { MultipartJpegParser, parseJpegGeometry, type CaptureGeometry, type RemoteFrame } from "@/features/remote/lib/remoteFrame";

export interface DisplayedRemoteFrame { width: number; height: number; geometry: CaptureGeometry | null }
export interface DecodedRemoteFrame extends DisplayedRemoteFrame { bitmap: ImageBitmap }
type Decode = (jpeg: Uint8Array) => Promise<ImageBitmap>;
interface DecodeJob {
  owner: symbol;
  frame: RemoteFrame;
  alive: () => boolean;
  present: (frame: DecodedRemoteFrame) => void;
  failed: (error: Error) => void;
}
const errorValue = (error: unknown) => error instanceof Error ? error : new Error(String(error));

// Bound decode allocation before invoking the browser decoder, including legacy
// frames without metadata. SOF dimensions come from JPEG, never a DPI estimate.
function jpegDecodeSize(jpeg: Uint8Array): { width: number; height: number } {
  for (let p = 2; p + 3 < jpeg.length;) {
    if (jpeg[p++] !== 0xff) break;
    while (jpeg[p] === 0xff) p++;
    const marker = jpeg[p++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
    const n = jpeg[p] * 256 + jpeg[p + 1];
    if (n < 2 || p + n > jpeg.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && n >= 8) {
      const height = jpeg[p + 3] * 256 + jpeg[p + 4], width = jpeg[p + 5] * 256 + jpeg[p + 6];
      if (width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 33_554_432) return { width, height };
      throw new Error("Screen frame exceeds the decode size limit");
    }
    p += n;
  }
  throw new Error("Screen frame has no valid JPEG dimensions");
}
async function decodeBrowserFrame(jpeg: Uint8Array): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") throw new Error("Live frame decoding is unavailable in this browser");
  return createImageBitmap(new Blob([jpeg.slice().buffer], { type: "image/jpeg" }));
}

/** One decode plus one latest pending JPEG, shared across stream/device switches.
 * Non-abortable old browser decodes occupy the lane until they settle; they can
 * never publish after cancellation, and their ImageBitmaps are always closed. */
export class MjpegDecodeLane {
  private busy = false;
  private pending: DecodeJob | null = null;
  constructor(private readonly decode: Decode = decodeBrowserFrame) {}
  offer(job: DecodeJob): void { this.pending = job; if (!this.busy) void this.pump(); }
  cancel(owner: symbol): void { if (this.pending?.owner === owner) this.pending = null; }
  private async pump(): Promise<void> {
    this.busy = true;
    while (this.pending) {
      const job = this.pending; this.pending = null;
      if (!job.alive()) continue;
      let bitmap: ImageBitmap | null = null;
      try {
        const expected = jpegDecodeSize(job.frame.jpeg);
        bitmap = await this.decode(job.frame.jpeg);
        if (!job.alive()) continue;
        if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height)
          || bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 16384 || bitmap.height > 16384 || bitmap.width * bitmap.height > 33_554_432) throw new Error("Invalid decoded frame size");
        // Decoding is required even when metadata is absent/malformed. Such frames
        // remain view-only. A decoder/SOF mismatch also invalidates their geometry.
        const geometry = expected.width === bitmap.width && expected.height === bitmap.height
          ? parseJpegGeometry(job.frame.jpeg, { allowNullDesktop: true, decodedDimensions: bitmap }) : null;
        job.present({ bitmap, width: bitmap.width, height: bitmap.height, geometry });
      } catch (error) { if (job.alive()) job.failed(errorValue(error)); }
      finally { bitmap?.close(); }
    }
    this.busy = false;
  }
}

interface StreamOptions {
  lane: MjpegDecodeLane;
  present: (frame: DecodedRemoteFrame) => void;
  stopped: (error: Error | null) => void;
  fetcher?: typeof fetch;
}
/** Transport owns AbortController, reader and parser. Drain after each 256-byte
 * slice so even coalesced network chunks cannot overflow the fixed parser queue.
 * At most 8 MiB per JPEG, one pending JPEG, one active decode; no async frame queue.
 * The fetch implementation/decoder's own buffers and canvas are browser-owned. */
export function startMjpegStream(url: string, options: StreamOptions): { cancel: () => void; done: Promise<void> } {
  const controller = new AbortController(), owner = Symbol("mjpeg-stream");
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let parser: MultipartJpegParser | null = null;
  let active = true;
  const stop = (error: Error | null) => {
    if (!active) return;
    active = false;
    controller.abort(); options.lane.cancel(owner); parser?.cancel();
    if (reader) void reader.cancel().catch(() => {});
    options.stopped(error);
  };
  const done = (async () => {
    try {
      const response = await (options.fetcher ?? fetch)(url, { credentials: "include", cache: "no-store", signal: controller.signal });
      if (!active) { void response.body?.cancel().catch(() => {}); return; }
      const fallback = response.status === 409
        ? "Screen selection is locked or unavailable. Release control, then reconnect; another operator may still have control."
        : `Screen stream request failed (${response.status}). Reconnect to try again.`;
      if (!response.body) throw new Error(fallback);
      reader = response.body.getReader();
      if (!response.ok) {
        const bytes = new Uint8Array(8192); let size = 0;
        while (active) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (size + chunk.value.length > bytes.length) throw new Error(fallback);
          bytes.set(chunk.value, size); size += chunk.value.length;
        }
        if (!active) return;
        let message = fallback;
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
          if (value && typeof value === "object" && "error" in value && typeof value.error === "string" && value.error.trim()) message = value.error.replace(/\s+/g, " ").slice(0, 512);
        } catch { /* keep the actionable, bounded fallback */ }
        throw new Error(message);
      }
      parser = new MultipartJpegParser(response.headers.get("Content-Type") ?? "", {
        allowNullDesktop: true, allowEofAfterPart: true, maxQueuedFrames: 16,
      });
      while (active) {
        const { done: ended, value } = await reader.read();
        if (!active) break;
        if (ended) { parser.finish(); stop(new Error("Screen stream ended. Reconnect to continue.")); break; }
        for (let p = 0; p < value.length && active; p += 256) {
          parser.push(value.subarray(p, p + 256));
          let frame: RemoteFrame | undefined;
          while ((frame = parser.takeFrame()) && active) options.lane.offer({
            owner, frame, alive: () => active, present: options.present, failed: error => stop(error),
          });
          if (parser.closed) { stop(new Error("Screen stream ended. Reconnect to continue.")); break; }
        }
      }
    } catch (error) { if (active) stop(errorValue(error)); }
    finally { try { reader?.releaseLock(); } catch { /* cancellation may still be settling */ } }
  })();
  return { cancel: () => stop(null), done };
}

interface HookOptions { beforeDisplay: (frame: DisplayedRemoteFrame | null) => void; stopped: () => void }
/** The canvas pixels and displayedRef are committed in one synchronous JS turn.
 * Input reads getDisplayed(), never the latest received or pending decoded frame. */
export function useMjpegFrames(url: string, enabled: boolean, canvas: RefObject<HTMLCanvasElement | null>, options: HookOptions) {
  const scope = enabled ? url : "";
  const currentScope = useRef(scope);
  const lane = useRef<MjpegDecodeLane | null>(null);
  if (lane.current == null) lane.current = new MjpegDecodeLane();
  const displayed = useRef<{ scope: string; frame: DisplayedRemoteFrame } | null>(null);
  const [state, setState] = useState<{ scope: string; frame: DisplayedRemoteFrame | null; error: string }>({ scope: "", frame: null, error: "" });
  const callbacks = useRef(options);
  useLayoutEffect(() => { callbacks.current = options; });
  // The canvas element commits after render and can swap without this hook's
  // inputs changing (layout switches remount it under the same ref), so the
  // stream callbacks read the committed element through this local ref rather
  // than touching the props ref after render.
  const canvasElement = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    canvasElement.current = canvas.current;
  });
  const activeStream = useRef<{ cancel: () => void } | null>(null);
  const stop = useCallback(() => activeStream.current?.cancel(), []);
  const getDisplayed = useCallback(() => displayed.current?.scope === currentScope.current ? displayed.current.frame : null, []);
  useLayoutEffect(() => {
    let live = true;
    const before = callbacks.current;
    currentScope.current = scope;
    const element = canvasElement.current;
    const clear = () => {
      before.beforeDisplay(null);
      displayed.current = null;
      // Resizing clears pixels without retaining an old full-sized backing store.
      if (element) { element.width = 1; element.height = 1; element.style.display = "none"; }
    };
    clear();
    setState({ scope, frame: null, error: "" });
    if (!scope) return () => { live = false; };
    const stream = startMjpegStream(scope, {
      lane: lane.current!,
      present: frame => {
        if (!live || currentScope.current !== scope) return;
        if (!element) throw new Error("Screen display is unavailable");
        const context = element.getContext("2d", { alpha: false });
        if (!context) throw new Error("Screen drawing is unavailable in this browser");
        const committed = { width: frame.width, height: frame.height, geometry: frame.geometry };
        callbacks.current.beforeDisplay(committed);
        element.width = frame.width; element.height = frame.height;
        context.drawImage(frame.bitmap, 0, 0);
        // The first canvas is initially hidden by the connecting placeholder.
        // Reveal its pixels now, rather than exposing a stamp ahead of React's
        // subsequent streaming-status render.
        element.style.display = "block";
        displayed.current = { scope, frame: committed };
        setState({ scope, frame: committed, error: "" });
      },
      stopped: error => {
        if (live) {
          clear();
          if (currentScope.current === scope) setState({ scope, frame: null, error: error?.message ?? "" });
        }
        before.stopped();
      },
    });
    activeStream.current = stream;
    // `scope` alone restarts the stream: the mirror above keeps the canvas
    // element fresh on every render without restarting it.
    return () => { stream.cancel(); live = false; if (activeStream.current === stream) activeStream.current = null; };
  }, [scope]);
  return { frame: state.scope === scope ? state.frame : null, error: state.scope === scope ? state.error : "", getDisplayed, stop };
}
