import { expect, test } from "bun:test";
import { StreamTuningQueue } from "@/features/remote/lib/streamTuningQueue";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("failed tuning retries and stops after three attempts", async () => {
  const queue = new StreamTuningQueue();
  let attempts = 0,
    failures = 0;
  queue.enqueue(
    async () => {
      attempts++;
      throw new Error("offline");
    },
    () => failures++,
  );
  await wait(1700);
  expect(attempts).toBe(3);
  expect(failures).toBe(1);
});
test("cancelling during backoff prevents obsolete retries", async () => {
  const queue = new StreamTuningQueue();
  let attempts = 0;
  const cancel = queue.enqueue(
    async () => {
      attempts++;
      throw new Error("offline");
    },
    () => {
      throw new Error("obsolete");
    },
  );
  await wait(10);
  cancel();
  await wait(550);
  expect(attempts).toBe(1);
});
test("rapid manual changes serialize and skip obsolete queued values", async () => {
  const queue = new StreamTuningQueue();
  const sent: number[] = [];
  let resolve!: () => void;
  const cancelFirst = queue.enqueue(
    async () => {
      sent.push(1);
      await new Promise<void>((r) => {
        resolve = r;
      });
    },
    () => {},
  );
  await wait(0);
  cancelFirst();
  const cancelSecond = queue.enqueue(
    async () => {
      sent.push(2);
    },
    () => {},
  );
  cancelSecond();
  queue.enqueue(
    async () => {
      sent.push(3);
    },
    () => {},
  );
  resolve();
  await wait(10);
  expect(sent).toEqual([1, 3]);
});
test("a transient failure retries without needing a new render", async () => {
  const queue = new StreamTuningQueue();
  let attempts = 0,
    failures = 0;
  queue.enqueue(
    async () => {
      if (++attempts === 1) throw new Error("temporary");
    },
    () => failures++,
  );
  await wait(650);
  expect(attempts).toBe(2);
  expect(failures).toBe(0);
});
