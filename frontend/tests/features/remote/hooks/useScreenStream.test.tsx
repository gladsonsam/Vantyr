import { afterEach, expect, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { testMock as vi } from "@tests/support/mock";

const tune = vi.fn(async (..._args: unknown[]) => {});
const remote = await import("@/api/endpoints/remote");
await vi.mock("@/api/endpoints/remote", () => ({ ...remote, tuneScreenStream: tune }));
await vi.mock("@/features/remote/hooks/useScreenStreamSource", () => ({
  useScreenStreamSource: () => ({
    useFrames: () => ({ stop: () => {}, detectsStalls: false }),
  }),
}));
const { useScreenStream } = await import("@/features/remote/hooks/useScreenStream");
let root: Root | undefined;
let view: ReturnType<typeof useScreenStream>;
let container: HTMLDivElement;
function Harness({ agentId = "one" }: { agentId?: string }) {
  const current = useScreenStream({
    agentId,
    streamEnabled: true,
    online: true,
    blockedByRole: false,
    onBeforeDisplay: () => {},
  });
  useLayoutEffect(() => {
    view = current;
  });
  return null;
}
async function mount() {
  localStorage.clear();
  tune.mockReset();
  tune.mockResolvedValue(undefined);
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root!.render(<Harness />));
}
const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  localStorage.clear();
});
test("a failed tuning POST retries without a render and stops after three attempts", async () => {
  await mount();
  tune.mockRejectedValue(new Error("unavailable"));
  await act(async () => view.changePreset("balanced"));
  await wait(1700);
  expect(tune).toHaveBeenCalledTimes(3);
  expect(view.tuningError).toBe(true);
  await wait(550);
  expect(tune).toHaveBeenCalledTimes(3);
});
test("an obsolete POST rejection cannot mark a new session as failed", async () => {
  await mount();
  let reject!: (error: Error) => void;
  tune.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  await act(async () => view.changePreset("balanced"));
  const oldSession = view.session;
  await act(async () => root!.render(<Harness agentId="two" />));
  expect(view.session).not.toBe(oldSession);
  await act(async () => reject(new Error("old request")));
  await wait(550);
  expect(view.tuningError).toBe(false);
  expect(tune).toHaveBeenCalledTimes(1);
});
test("preset replacement cancels backoff and applies the latest tuning", async () => {
  await mount();
  tune.mockRejectedValueOnce(new Error("temporary"));
  await act(async () => view.changePreset("balanced"));
  await act(async () => view.changePreset("ultra"));
  await wait(600);
  expect(tune).toHaveBeenCalledTimes(2);
  expect(view.preset).toBe("ultra");
  expect(view.tuningError).toBe(false);
});
