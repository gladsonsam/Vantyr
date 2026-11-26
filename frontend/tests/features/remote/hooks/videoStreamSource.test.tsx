import { testMock as vi } from "@tests/support/mock";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "bun:test";

import type { FrameSource } from "@/features/remote/lib/screenStreamSource";

await vi.mock("@/api", () => ({ notifyMjpegViewerLeft: vi.fn() }));
const { adaptiveScreenStreamSource } = await import("@/features/remote/hooks/videoStreamSource");
const { videoPacket, wirePacket } = await import("./videoTestFixtures");
let root: Root, container: HTMLDivElement;
let output: VideoDecoderInit["output"];
const decode = vi.fn(),
  close = vi.fn(),
  draw = vi.fn();
let source: FrameSource;
const before = vi.fn(),
  report = vi.fn();
const settle = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
};
function Harness({
  session = "one",
  layout = "card",
}: {
  session?: string;
  layout?: "card" | "embedded";
}) {
  const current = adaptiveScreenStreamSource.useFrames({
    agentId: "device",
    session,
    videoEnabled: true,
    streamUrl: `/api/agents/device/mjpeg?session=${session}`,
    streamEnabled: true,
    enabled: true,
    online: true,
    onBeforeDisplay: before,
    report,
  });
  useLayoutEffect(() => {
    source = current;
  });
  return (
    <section key={layout}>
      {current.render({ layout, visible: true, streamEnabled: true, transform: "" })}
    </section>
  );
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "VideoDecoder",
    class {
      state = "configured";
      decodeQueueSize = 0;
      constructor(options: VideoDecoderInit) {
        output = options.output;
      }
      configure = vi.fn();
      decode = decode;
      close() {
        this.state = "closed";
        close();
      }
    },
  );
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(init: EncodedVideoChunkInit) {
        Object.assign(this, init);
      }
    },
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});
it("binds control geometry to decoded output, bounds decode backlog and clears input on session replacement", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream({
      start(c) {
        controller = c;
      },
    }),
  );
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => {
    root.render(<Harness />);
    await settle();
  });
  expect(fetcher.mock.calls[0][0]).toContain("/video?");
  expect(fetcher.mock.calls[0][1].credentials).toBe("include");
  await act(async () => {
    for (let n = 1; n <= 8; n++) controller.enqueue(wirePacket(videoPacket(n)));
    await settle();
  });
  expect(decode).toHaveBeenCalledTimes(3);
  expect(source.verified).toBe(false);
  const stableCallbacks = [
    source.surface,
    source.inputStamp,
    source.verifiedNow,
    source.leaseStamp,
    source.stop,
  ];
  const frameClose = vi.fn();
  await act(async () => {
    output({
      timestamp: 1,
      displayWidth: 16,
      displayHeight: 24,
      close: frameClose,
    } as unknown as VideoFrame);
  });
  expect([
    source.surface,
    source.inputStamp,
    source.verifiedNow,
    source.leaseStamp,
    source.stop,
  ]).toEqual(stableCallbacks);
  expect(source.inputStamp().stamp?.geometry_revision).toBe(1);
  expect(draw).toHaveBeenCalledOnce();
  expect(frameClose).toHaveBeenCalledOnce();
  const oldOutput = output;
  await act(async () => {
    root.render(<Harness session="two" />);
    await settle();
  });
  expect(source.inputStamp().ok).toBe(false);
  expect(close).toHaveBeenCalled();
  const staleClose = vi.fn();
  // This is the actual old decoder callback, with queued old-session work.
  await act(async () => {
    oldOutput({
      timestamp: 2,
      displayWidth: 16,
      displayHeight: 24,
      close: staleClose,
    } as unknown as VideoFrame);
  });
  expect(source.inputStamp().ok).toBe(false);
  expect(staleClose).toHaveBeenCalled();
});
it("rejects decoded dimensions that disagree with capture geometry", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
          },
        }),
      ),
    ),
  );
  await act(async () => {
    root.render(<Harness />);
    await settle();
    controller.enqueue(wirePacket());
    await settle();
  });
  await act(async () => {
    output({
      timestamp: 1,
      displayWidth: 100,
      displayHeight: 24,
      close: vi.fn(),
    } as unknown as VideoFrame);
  });
  expect(source.failed).toBe(true);
  expect(source.inputStamp().ok).toBe(false);
  expect(draw).not.toHaveBeenCalled();
});

it("invalidates pixels and control on a canvas layout remount, then draws into the new canvas", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          controller = c;
        },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  await act(async () => {
    root.render(<Harness />);
    await settle();
    controller.enqueue(wirePacket());
    await settle();
  });
  await act(async () =>
    output({
      timestamp: 1,
      displayWidth: 16,
      displayHeight: 24,
      close: vi.fn(),
    } as unknown as VideoFrame),
  );
  expect(source.verified).toBe(true);
  const original = container.querySelector("canvas")!;
  await act(async () => root.render(<Harness layout="embedded" />));
  const replacement = container.querySelector("canvas")!;
  expect(replacement).not.toBe(original);
  expect(original.width).toBe(1);
  expect(source.verified).toBe(false);
  expect(source.inputStamp().ok).toBe(false);
  expect(source.surface()).toBeNull();
  expect(replacement.style.display).toBe("none");
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => {
    controller.enqueue(wirePacket(videoPacket(2)));
    await settle();
  });
  await act(async () =>
    output({
      timestamp: 2,
      displayWidth: 16,
      displayHeight: 24,
      close: vi.fn(),
    } as unknown as VideoFrame),
  );
  expect(source.inputStamp().stamp?.geometry_revision).toBe(2);
  expect(replacement.width).toBe(16);
});
it("stops a hidden stream, clears geometry and ignores queued decoder output", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            controller = c;
          },
          cancel,
        }),
      ),
    ),
  );
  await act(async () => {
    root.render(<Harness />);
    await settle();
    controller.enqueue(wirePacket());
    await settle();
  });
  const queuedOutput = output;
  vi.spyOnGetter(document, "hidden").mockReturnValue(true);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(source.inputStamp().ok).toBe(false);
  const frameClose = vi.fn();
  await act(async () =>
    queuedOutput({
      timestamp: 1,
      displayWidth: 16,
      displayHeight: 24,
      close: frameClose,
    } as unknown as VideoFrame),
  );
  expect(draw).not.toHaveBeenCalled();
  expect(frameClose).toHaveBeenCalledOnce();
});
it("ends an initial connection that produces no frame within fifteen seconds", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => {
    root.render(<Harness />);
    await settle();
  });
  expect(source.connecting).toBe(true);
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(source.failed).toBe(true);
  expect(source.failureReason).toContain("did not connect");
  expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
  expect(source.inputStamp().ok).toBe(false);
  expect(close).toHaveBeenCalledOnce();
});
it("cancels late fetch bodies without allowing old cancellation failures to affect the next session", async () => {
  let resolveOld!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockReturnValueOnce(oldResponse)
      .mockImplementation(() => new Promise(() => {})),
  );
  await act(async () => {
    root.render(<Harness />);
    await settle();
  });
  await act(async () => {
    root.render(<Harness session="two" />);
    await settle();
  });
  const cancel = vi.fn(async () => {
    throw new Error("already aborted");
  });
  await act(async () => {
    resolveOld({ body: { cancel } } as unknown as Response);
    await settle();
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(source.failed).toBe(false);
  expect(source.connecting).toBe(true);
});

it("surfaces the bounded server reason for a rejected stream rather than assuming a codec conflict", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "H.264 streaming requires an updated agent with video support.",
        }),
        { status: 409 },
      ),
    ),
  );
  await act(async () => {
    root.render(<Harness />);
    await settle();
  });
  expect(source.failureReason).toBe(
    "H.264 streaming requires an updated agent with video support.",
  );
  expect(source.inputStamp().ok).toBe(false);
});
it("bounds rejected-response bodies and uses an actionable fallback", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("x".repeat(8193), { status: 409 })),
  );
  await act(async () => {
    root.render(<Harness />);
    await settle();
  });
  expect(source.failureReason).toContain("Screen selection is locked or unavailable");
  expect(source.failureReason!.length).toBeLessThan(512);
});
