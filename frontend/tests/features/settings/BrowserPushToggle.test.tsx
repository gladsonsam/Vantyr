// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { buttonByText, click, mountForm, unmountForms } from "@tests/support/formDom";
import { BrowserPushToggle } from "@/features/settings/BrowserPushToggle";

const api = vi.hoisted(() => ({ pushVapidPublicKey: vi.fn(), pushSubscribe: vi.fn(), pushUnsubscribe: vi.fn() }));
const pwa = vi.hoisted(() => ({ isPushSupported: vi.fn(), getExistingSubscription: vi.fn(), subscribeToPush: vi.fn() }));
vi.mock("@/api", () => ({ api, errorText: (e: unknown) => String(e instanceof Error ? e.message : e) }));
vi.mock("@/lib/pwa", () => pwa);

let permission: NotificationPermission = "default";
let requested: NotificationPermission = "granted";
let subscription: { endpoint: string; unsubscribe: () => Promise<boolean>; toJSON: () => unknown } | null = null;
const makeSub = () => ({
  endpoint: "https://push.example/1",
  unsubscribe: vi.fn(async () => { subscription = null; return true; }),
  toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }),
});

beforeEach(() => {
  vi.clearAllMocks();
  permission = "default";
  requested = "granted";
  subscription = null;
  const NotificationStub = function Notification() {};
  Object.defineProperty(NotificationStub, "permission", { get: () => permission });
  Object.assign(NotificationStub, { requestPermission: vi.fn(async () => { permission = requested; return requested; }) });
  Object.assign(globalThis, { Notification: NotificationStub });
  pwa.isPushSupported.mockReturnValue(true);
  pwa.getExistingSubscription.mockImplementation(async () => subscription);
  pwa.subscribeToPush.mockImplementation(async () => { subscription = makeSub(); return subscription; });
  api.pushVapidPublicKey.mockResolvedValue({ publicKey: "KEY", enabled: true });
  api.pushSubscribe.mockResolvedValue({ ok: true });
  api.pushUnsubscribe.mockResolvedValue({ ok: true });
});
afterEach(unmountForms);

const render = () => mountForm(withQueryClient(<BrowserPushToggle />, createTestQueryClient()));
const text = () => document.body.textContent ?? "";
const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;

describe("browser notifications", () => {
  it("says so when this browser cannot do push", async () => {
    pwa.isPushSupported.mockReturnValue(false);
    await render();
    expect(text()).toContain("Not supported on this browser");
    expect(api.pushVapidPublicKey).not.toHaveBeenCalled();
  });

  it("does not call a failed status check 'not set up on the server'", async () => {
    api.pushVapidPublicKey.mockRejectedValue(new Error("offline"));
    await render();
    expect(text()).toContain("Couldn't check notification status");
    expect(text()).toContain("offline");
    expect(text()).not.toContain("isn't set up on the server");
    expect(document.querySelector('[role="switch"]')).toBeNull();
    api.pushVapidPublicKey.mockResolvedValue({ publicKey: "KEY", enabled: true });
    await click(buttonByText("Try again"));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("explains when the server has no push key", async () => {
    api.pushVapidPublicKey.mockResolvedValue({ publicKey: null, enabled: false });
    await render();
    expect(text()).toContain("Browser push isn't set up on the server");
    expect(document.querySelector('[role="switch"]')).toBeNull();
  });

  it("turns on only after the browser subscribes and the server accepts, then shows On", async () => {
    await render();
    expect(text()).toContain("Off");
    await click(toggle());
    expect(api.pushSubscribe).toHaveBeenCalledWith({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("On");
  });

  it("stays off and says why when permission is not given", async () => {
    requested = "default";
    await render();
    await click(toggle());
    expect(api.pushSubscribe).not.toHaveBeenCalled();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain("Permission wasn't given");
  });

  it("locks the switch when notifications are blocked for the site", async () => {
    permission = "denied";
    await render();
    expect(toggle().hasAttribute("disabled") || toggle().getAttribute("aria-disabled") === "true").toBe(true);
    expect(text()).toContain("blocked for this site");
  });

  it("stays off and reports a refused subscription", async () => {
    api.pushSubscribe.mockRejectedValue(new Error("Server said no"));
    await render();
    await click(toggle());
    expect(text()).toContain("Couldn't turn on notifications");
    expect(text()).toContain("Server said no");
    expect(subscription).toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("reports a browser refusal to remove a subscription after the server accepted", async () => {
    subscription = makeSub();
    subscription.unsubscribe = vi.fn(async () => false);
    await render();
    await click(toggle());
    expect(text()).toContain("Couldn't turn off notifications");
    expect(text()).toContain("this browser could not remove its subscription");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the browser subscribed when the server cannot be told, so Off is never a lie", async () => {
    subscription = makeSub();
    api.pushUnsubscribe.mockRejectedValue(new Error("Server said no"));
    await render();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await click(toggle());
    expect(text()).toContain("Couldn't turn off notifications");
    expect(subscription).not.toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    api.pushUnsubscribe.mockResolvedValue({ ok: true });
    await click(toggle());
    expect(api.pushUnsubscribe).toHaveBeenLastCalledWith("https://push.example/1");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
});
