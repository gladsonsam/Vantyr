import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:3000",
  pretendToBeVisual: true,
});
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis))
    Object.defineProperty(globalThis, key, {
      ...Object.getOwnPropertyDescriptor(dom.window, key)!,
      configurable: true,
    });
}
for (const key of [
  "window",
  "document",
  "navigator",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "CustomEvent",
  "HTMLElement",
  "Element",
  "Node",
  "HTMLInputElement",
  "HTMLTextAreaElement",
] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: dom.window[key],
  });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
