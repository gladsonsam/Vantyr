import { testMock as vi } from "@tests/support/mock";
import { afterEach, describe, expect, it } from "bun:test";
import { click, mountForm, unmountForms } from "@tests/support/formDom";
import { IDLE_APP } from "@/features/activity/appColor";
import type { Session } from "@/features/activity/sessionAggregator";
import { SessionRow } from "@/features/activity/SessionRow";

afterEach(unmountForms);

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    appName: "searchhost.exe",
    appDisplayName: "Search",
    windowTitle: "Search",
    startTime: new Date(2026, 0, 15, 9, 0, 0),
    endTime: new Date(2026, 0, 15, 9, 5, 0),
    duration: 300,
    keystrokeCount: 0,
    urls: [],
    keystrokes: [],
    windows: [],
    hasKeystrokes: false,
    hasUrls: false,
    ...overrides,
  };
}

const alertEvent = {
  id: 7,
  rule_name: "Social media",
  channel: "url",
  snippet: "facebook.com/profile",
  created_at: new Date(2026, 0, 15, 9, 2, 0).toISOString(),
  has_screenshot: false,
  screenshot_requested: false,
};

const mount = (s: Session) =>
  mountForm(
    <SessionRow
      session={s}
      highlighted={false}
      focused={false}
      onOpenScreenshot={vi.fn()}
      onFilterApp={vi.fn()}
    />,
  );

describe("SessionRow", () => {
  it("does not repeat a window title that only restates the app name", async () => {
    await mount(session());
    expect(document.body.textContent?.match(/Search/g)).toHaveLength(1);
  });

  it("keeps a window title that adds information", async () => {
    await mount(session({ windowTitle: "Search results for invoices" }));
    expect(document.body.textContent).toContain("Search results for invoices");
  });

  it("renders a quiet idle gap as one non-interactive line", async () => {
    await mount(session({ appName: IDLE_APP, appDisplayName: "Idle", windowTitle: "" }));
    expect(document.querySelector('[role="button"]')).toBeNull();
    expect(document.body.textContent).toContain("Idle");
  });

  it("opens an idle stretch that holds an alert so the evidence is reachable", async () => {
    await mount(
      session({
        appName: IDLE_APP,
        appDisplayName: "Idle",
        windowTitle: "",
        alertEvents: [alertEvent],
      }),
    );
    const heading = document.querySelector('[role="button"]') as HTMLElement;
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    await click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Social media");
    expect(document.body.textContent).toContain("facebook.com/profile");
  });
});
