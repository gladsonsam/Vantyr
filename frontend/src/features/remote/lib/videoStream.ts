import { VideoPacketParser, type VideoPacket } from "./videoFrame";

interface VideoStreamOptions {
  present: (frame: VideoFrame, packet: VideoPacket) => void;
  stopped: (error: string) => void;
}

/** One ordered video transport. Owns every decoder, read and connection timer.
 * Each access unit is independent, so dropping before decode safely bounds latency.
 */
export function startVideoStream(url: string, options: VideoStreamOptions): { cancel: () => void } {
  let alive = true;
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let decoder: VideoDecoder | null = null;
  let configuration = "";
  let serial = 0;
  const pending = new Map<number, VideoPacket>();
  const end = (error = "") => {
    if (!alive) return;
    alive = false;
    abort.abort();
    clearTimeout(connectionTimeout);
    void reader?.cancel().catch(() => {});
    if (decoder && decoder.state !== "closed") decoder.close();
    pending.clear();
    options.stopped(error);
  };
  const connectionTimeout = setTimeout(
    () => end("Live view did not connect. Reconnect to try again."),
    15_000,
  );
  const receive = (packet: VideoPacket) => {
    if (!alive || !decoder || decoder.state === "closed") return;
    if (pending.size >= 3 || decoder.decodeQueueSize >= 2) return;
    if (configuration !== packet.codec) {
      if (pending.size) return;
      decoder.configure({ codec: packet.codec, optimizeForLatency: true });
      configuration = packet.codec;
    }
    const timestamp = ++serial;
    pending.set(timestamp, packet);
    decoder.decode(
      new EncodedVideoChunk({ type: "key", timestamp, data: packet.data.slice().buffer }),
    );
  };
  void (async () => {
    try {
      if (typeof VideoDecoder === "undefined")
        throw new Error("Video decoding is unavailable in this browser.");
      decoder = new VideoDecoder({
        error: () => end("Video decoding failed. Reconnect to try again."),
        output: (frame) => {
          try {
            const packet = pending.get(frame.timestamp);
            pending.delete(frame.timestamp);
            if (!alive || !packet) return;
            options.present(frame, packet);
            clearTimeout(connectionTimeout);
          } catch (error) {
            end(error instanceof Error ? error.message : "Video display failed.");
          } finally {
            frame.close();
          }
        },
      });
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        signal: abort.signal,
      });
      if (!alive) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      const fallback =
        response.status === 409
          ? "Screen selection is locked or unavailable. Release control, then reconnect; another operator may still have control."
          : `Screen stream request failed (${response.status}). Reconnect to try again.`;
      if (!response.body) throw new Error(fallback);
      reader = response.body.getReader();
      if (!response.ok) throw new Error(await readVideoError(reader, fallback));
      const parser = new VideoPacketParser();
      // pipeTo preserves byte order and applies backpressure without concurrent reads.
      await readableVideoBytes(reader).pipeTo(
        new WritableStream<Uint8Array>({
          write: (chunk) => {
            if (alive) parser.push(chunk, receive);
          },
        }),
        { signal: abort.signal },
      );
      if (alive) {
        parser.finish();
        throw new Error("Screen stream ended. Reconnect to continue.");
      }
    } catch (error) {
      if (alive) end(error instanceof Error ? error.message : "Video stream failed.");
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        /* an aborted read may still be settling */
      }
    }
  })();
  return { cancel: () => end() };
}

function readableVideoBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: () => reader.cancel(),
  });
}

async function readVideoError(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fallback: string,
): Promise<string> {
  const bytes = new Uint8Array(8192);
  let size = 0;
  await readableVideoBytes(reader).pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        if (size + chunk.length > bytes.length) throw new Error(fallback);
        bytes.set(chunk, size);
        size += chunk.length;
      },
    }),
  );
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
    if (
      value &&
      typeof value === "object" &&
      "error" in value &&
      typeof value.error === "string" &&
      value.error.trim()
    )
      return value.error.replace(/\s+/g, " ").slice(0, 512);
  } catch {
    /* retain the bounded, actionable fallback */
  }
  return fallback;
}
