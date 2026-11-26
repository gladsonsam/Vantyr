import { expect, it } from "bun:test";

it("uses the Vite test-mode asset root and development flags", () => {
  expect(import.meta.env.BASE_URL).toBe("/");
  expect(import.meta.env.MODE).toBe("test");
  expect(import.meta.env.DEV).toBe(true);
  expect(import.meta.env.PROD).toBe(false);
});

it("removes DOM listeners when their abort signal is cancelled", () => {
  const controller = new window.AbortController();
  let events = 0;
  const target = document.createElement("div");
  target.addEventListener("test-event", () => events++, { signal: controller.signal });
  target.dispatchEvent(new Event("test-event"));
  controller.abort();
  target.dispatchEvent(new Event("test-event"));
  expect(events).toBe(1);
});
