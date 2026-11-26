import { mock, vi, setSystemTime, type Mock } from "bun:test";

const globals = new Map<PropertyKey, PropertyDescriptor | undefined>();
const windowGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
const getters: (() => void)[] = [];
const env = new Map<string, string | undefined>();

/** Small browser-test utilities around Bun's native mocks. Module mocks are registered before dynamic imports. */
export const testMock = {
  ...vi,
  async mock(specifier: string, factory: () => unknown) {
    const original = specifier === "@/api" ? await import("@/api") : {};
    const replacement = await factory();
    return mock.module(specifier, () => ({ ...original, ...(replacement as object) }));
  },
  restoreAllMocks() {
    vi.restoreAllMocks();
    for (const restore of getters.splice(0).reverse()) restore();
  },
  mocked: <T extends (...args: never[]) => unknown>(value: T): Mock<T> =>
    value as unknown as Mock<T>,
  useFakeTimers(options?: { toFake?: string[]; now?: number | Date }) {
    if (options?.toFake?.length === 1 && options.toFake[0] === "Date") {
      if (options.now !== undefined) setSystemTime(options.now);
    } else vi.useFakeTimers(options);
  },
  spyOnGetter<T extends object, K extends keyof T>(object: T, key: K): Mock<() => T[K]> {
    const original = Object.getOwnPropertyDescriptor(object, key);
    let owner: object | null = object;
    let descriptor = original;
    while (!descriptor && owner) {
      owner = Object.getPrototypeOf(owner);
      if (owner) descriptor = Object.getOwnPropertyDescriptor(owner, key);
    }
    const getter = mock((): T[K] =>
      descriptor?.get ? descriptor.get.call(object) : descriptor?.value,
    );
    Object.defineProperty(object, key, { configurable: true, get: getter });
    getters.push(() => {
      if (original) Object.defineProperty(object, key, original);
      else Reflect.deleteProperty(object, key);
    });
    return getter;
  },
  setSystemTime,
  stubGlobal(name: PropertyKey, value: unknown) {
    if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    if (typeof name === "string" && name !== "window") {
      if (!windowGlobals.has(name))
        windowGlobals.set(name, Object.getOwnPropertyDescriptor(window, name));
      Object.defineProperty(window, name, { configurable: true, writable: true, value });
    }
  },
  unstubAllGlobals() {
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    globals.clear();
    for (const [name, descriptor] of windowGlobals) {
      if (descriptor) Object.defineProperty(window, name, descriptor);
      else Reflect.deleteProperty(window, name);
    }
    windowGlobals.clear();
  },
  stubEnv(name: string, value: string) {
    if (!env.has(name)) env.set(name, process.env[name]);
    process.env[name] = value;
  },
  unstubAllEnvs() {
    for (const [name, value] of env) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    env.clear();
  },
  async waitFor(assertion: () => unknown, options: { timeout?: number; interval?: number } = {}) {
    const deadline = performance.now() + (options.timeout ?? 1000);
    for (;;) {
      try {
        return await assertion();
      } catch (error) {
        if (performance.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, options.interval ?? 10));
      }
    }
  },
};
