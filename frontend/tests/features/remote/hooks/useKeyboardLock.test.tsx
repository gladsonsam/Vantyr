import { testMock as vi } from "@tests/support/mock";
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { useKeyboardLock } from "@/features/remote/hooks/useKeyboardLock";
import { deferred } from "@/features/remote/hooks/mjpegTestFixtures";

let host: HTMLDivElement, root: Root, state: ReturnType<typeof useKeyboardLock>;
const lock = vi.fn(),
  unlock = vi.fn();
function Harness({ wanted }: { wanted: boolean }) {
  const value = useKeyboardLock(wanted);
  useEffect(() => {
    state = value;
  });
  return <span>{value.status}</span>;
}
const render = (wanted: boolean, strict = false) =>
  act(async () =>
    root.render(
      strict ? (
        <StrictMode>
          <Harness wanted={wanted} />
        </StrictMode>
      ) : (
        <Harness wanted={wanted} />
      ),
    ),
  );
const domError = (name: string) => new DOMException("nope", name);
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  lock.mockReset().mockResolvedValue(undefined);
  unlock.mockReset();
  Object.defineProperty(navigator, "keyboard", { configurable: true, value: { lock, unlock } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(navigator, "keyboard");
});

it("never touches the keyboard until a lock is wanted", async () => {
  await render(false);
  expect(state.status).toBe("idle");
  expect(lock).not.toHaveBeenCalled();
});
it("locks all keys when wanted and unlocks when no longer wanted", async () => {
  await render(true);
  expect(lock).toHaveBeenCalledTimes(1);
  expect(lock).toHaveBeenCalledWith(undefined);
  expect(state.status).toBe("locked");
  await render(false);
  expect(unlock).toHaveBeenCalledTimes(1);
  expect(state.status).toBe("idle");
});
it("unlocks on unmount", async () => {
  await render(true);
  unlock.mockClear();
  await act(async () => root.unmount());
  root = createRoot(host);
  expect(unlock).toHaveBeenCalledTimes(1);
});
it("reports locking while the browser permission prompt is pending", async () => {
  const pending = deferred<void>();
  lock.mockReturnValue(pending.promise);
  await render(true);
  expect(state.status).toBe("locking");
  await act(async () => pending.resolve());
  expect(state.status).toBe("locked");
});
it("unlocks a lock that resolves after the request was withdrawn", async () => {
  const pending = deferred<void>();
  lock.mockReturnValue(pending.promise);
  await render(true);
  await render(false);
  unlock.mockClear();
  await act(async () => pending.resolve());
  expect(unlock).toHaveBeenCalledTimes(1);
  expect(state.status).toBe("idle");
});
it("ignores a stale resolve once a newer request is live and does not unlock it", async () => {
  const first = deferred<void>(),
    second = deferred<void>();
  lock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render(true);
  await render(false);
  await render(true);
  unlock.mockClear();
  await act(async () => first.resolve());
  expect(unlock).not.toHaveBeenCalled();
  expect(state.status).toBe("locking");
  await act(async () => second.resolve());
  expect(state.status).toBe("locked");
});
it("ignores a stale denial after the request was withdrawn", async () => {
  const pending = deferred<void>();
  lock.mockReturnValue(pending.promise);
  await render(true);
  await render(false);
  await act(async () => pending.reject(domError("NotAllowedError")));
  expect(state.status).toBe("idle");
  lock.mockResolvedValue(undefined);
  await render(true);
  expect(state.status).toBe("locked");
});
it("treats a lock superseded by a newer call as neither a failure nor a denial", async () => {
  lock.mockRejectedValueOnce(domError("AbortError")).mockResolvedValue(undefined);
  await render(true);
  expect(state.status).toBe("locking");
});
it("reports a refused permission and retries on a fresh screen gesture", async () => {
  lock.mockRejectedValueOnce(domError("NotAllowedError"));
  await render(true);
  expect(state.status).toBe("denied");
  lock.mockResolvedValue(undefined);
  await act(async () => state.retry());
  expect(lock).toHaveBeenCalledTimes(2);
  expect(state.status).toBe("locked");
});
it("retries a failure that is not a refusal on request", async () => {
  lock.mockRejectedValueOnce(domError("InvalidStateError"));
  await render(true);
  expect(state.status).toBe("failed");
  await act(async () => state.retry());
  expect(lock).toHaveBeenCalledTimes(2);
  expect(state.status).toBe("locked");
});
it("says unsupported without throwing where the Keyboard Lock API is missing", async () => {
  Reflect.deleteProperty(navigator, "keyboard");
  await render(true);
  expect(state.status).toBe("unsupported");
  await render(false);
  expect(state.status).toBe("idle");
});
it("ends with exactly one live lock under StrictMode's double effect", async () => {
  await render(true, true);
  expect(state.status).toBe("locked");
  expect(lock.mock.calls.length - unlock.mock.calls.length).toBe(1);
});
