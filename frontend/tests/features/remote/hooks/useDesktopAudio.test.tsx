import { testMock as vi } from "@tests/support/mock";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "bun:test";

await vi.mock("@/api", () => ({ apiUrl: (path: string) => path }));
const { useDesktopAudio } = await import("@/features/remote/hooks/useDesktopAudio");
const { deferred } = await import("@/features/remote/hooks/mjpegTestFixtures");
let host: HTMLDivElement, root: Root;
let audio: ReturnType<typeof useDesktopAudio>;
const contexts: FakeAudioContext[] = [];
class FakeAudioContext {
  state = "suspended";
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createBuffer = vi.fn((channels: number, frames: number, rate: number) => ({
    duration: frames / rate,
    getChannelData: () => new Float32Array(frames * channels),
  }));
  createBufferSource = vi.fn(() => ({ connect: vi.fn(), start: vi.fn(), buffer: null }));
  constructor() {
    contexts.push(this);
  }
}
function Harness({ id = "device", enabled = true }: { id?: string; enabled?: boolean }) {
  const current = useDesktopAudio({ agentId: id, online: true, enabled });
  useLayoutEffect(() => {
    audio = current;
  });
  return null;
}
beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  contexts.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("unlocks audio before fetching and reports unavailable audio instead of appearing active", async () => {
  const pending = deferred<Response>();
  const fetcher = vi.fn(() => pending.promise);
  vi.stubGlobal("fetch", fetcher);
  let started!: Promise<void>;
  await act(async () => {
    started = audio.start();
  });
  expect(contexts[0].resume).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(audio.connecting).toBe(true);
  expect(audio.active).toBe(false);
  await act(async () => {
    pending.resolve(new Response(null, { status: 403 }));
    await started;
  });
  expect(audio.connecting).toBe(false);
  expect(audio.active).toBe(false);
  expect(audio.error).toContain("Check device audio permission");
  expect(contexts[0].close).toHaveBeenCalledOnce();
});
it("does not let a cancelled request close a newer audio connection", async () => {
  const oldResponse = deferred<Response>(),
    nextResponse = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(nextResponse.promise),
  );
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => {
    first = audio.start();
  });
  await act(async () => {
    second = audio.start();
  });
  await act(async () => {
    oldResponse.resolve(new Response(null, { status: 403 }));
    await first;
  });
  expect(contexts[1].close).not.toHaveBeenCalled();
  expect(audio.connecting).toBe(true);
  expect(audio.error).toBe("");
  await act(async () => {
    nextResponse.resolve(new Response(null, { status: 403 }));
    await second;
  });
});
it("stops playback when the device or permission changes", async () => {
  const pending = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => pending.promise),
  );
  let started!: Promise<void>;
  await act(async () => {
    started = audio.start();
  });
  await act(async () => root.render(<Harness id="other-device" enabled={false} />));
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(audio.connecting).toBe(false);
  expect(audio.active).toBe(false);
  await act(async () => {
    pending.resolve(new Response(null, { status: 403 }));
    await started;
  });
  expect(audio.error).toBe("");
});
it("keeps silent audio connected after receiving a valid format header", async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body)),
  );
  let started!: Promise<void>;
  await act(async () => {
    started = audio.start();
  });
  const header = new Uint8Array(6);
  const view = new DataView(header.buffer);
  view.setUint32(0, 48000, true);
  view.setUint16(4, 2, true);
  await act(async () => stream.enqueue(header));
  expect(audio.connecting).toBe(false);
  expect(audio.active).toBe(true);
  await act(async () => vi.advanceTimersByTime(16_000));
  expect(audio.active).toBe(true);
  expect(audio.error).toBe("");
  expect(contexts[0].createBufferSource).not.toHaveBeenCalled();
  await act(async () => {
    stream.close();
    await started;
  });
  expect(audio.active).toBe(false);
  expect(audio.error).toContain("disconnected");
});
