import { afterEach, expect, it } from "bun:test";
import { testMock } from "./mock";

afterEach(() => {
  testMock.restoreAllMocks();
  testMock.unstubAllGlobals();
  testMock.unstubAllEnvs();
  testMock.useRealTimers();
});

it("restores separate global and window descriptors after repeated stubs", () => {
  const local = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  const browser = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const first = testMock.fn();
  testMock.stubGlobal("matchMedia", first);
  expect(globalThis.matchMedia).toBe(first);
  expect(window.matchMedia).toBe(first);
  testMock.stubGlobal("matchMedia", testMock.fn());
  testMock.unstubAllGlobals();
  expect(Object.getOwnPropertyDescriptor(globalThis, "matchMedia")).toEqual(local);
  expect(Object.getOwnPropertyDescriptor(window, "matchMedia")).toEqual(browser);
});

it("keeps inherited getters live and removes the override on restore", () => {
  let value = false;
  const prototype = {
    get hidden() {
      return value;
    },
  };
  const target = Object.create(prototype) as typeof prototype;
  const getter = testMock.spyOnGetter(target, "hidden");
  value = true;
  expect(target.hidden).toBe(true);
  getter.mockReturnValue(false);
  expect(target.hidden).toBe(false);
  testMock.restoreAllMocks();
  expect(Object.prototype.hasOwnProperty.call(target, "hidden")).toBe(false);
  expect(target.hidden).toBe(true);
});

it("restores an existing environment value after repeated changes", () => {
  const before = process.env.VANTYR_TEST_MOCK_ENV;
  testMock.stubEnv("VANTYR_TEST_MOCK_ENV", "first");
  testMock.stubEnv("VANTYR_TEST_MOCK_ENV", "second");
  expect(process.env.VANTYR_TEST_MOCK_ENV).toBe("second");
  testMock.unstubAllEnvs();
  expect(process.env.VANTYR_TEST_MOCK_ENV).toBe(before);
});
