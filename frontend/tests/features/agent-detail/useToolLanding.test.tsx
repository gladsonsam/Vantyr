import { testMock as vi } from "@tests/support/mock";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TabKey } from "@/features/agent-detail/lib/agentTabNav";
import { shouldLandOnArrival } from "@/features/agent-detail/lib/toolLanding";
import { useToolLanding } from "@/features/agent-detail/useToolLanding";

interface HarnessProps {
  tab: TabKey;
  agentId?: string;
  scrollRequested?: boolean;
  hasMoment?: boolean;
}

const changeTab = vi.fn();

function Harness({
  tab,
  agentId = "a1",
  scrollRequested = false,
  hasMoment = false,
}: HarnessProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const land = useToolLanding({ rootRef, agentId, activeTab: tab, scrollRequested, hasMoment });
  return (
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      {(["windows", "files"] as const).map((next) => (
        <button key={next} data-pick={next} onClick={() => land(next, changeTab)} />
      ))}
      <div ref={rootRef}>
        <nav className="agent-detail-section-tabs" />
        <div data-agent-tool-content />
      </div>
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;
let writes: number[];
let contentOffset: number;
let observed: (() => void) | null;

function stubGeometry() {
  const scroller = host.querySelector<HTMLElement>("[data-testid=scroller]")!;
  let top = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
      writes.push(value);
    },
  });
  Object.defineProperty(host.querySelector(".agent-detail-section-tabs")!, "offsetHeight", {
    configurable: true,
    value: 50,
  });
  host.querySelector("[data-agent-tool-content]")!.getBoundingClientRect = () =>
    ({ top: contentOffset - top }) as DOMRect;
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
}

function pick(tab: "windows" | "files") {
  host.querySelector<HTMLButtonElement>(`[data-pick=${tab}]`)!.click();
}

async function render(props: HarnessProps) {
  await act(async () => root.render(<Harness {...props} />));
  stubGeometry();
  await act(async () => void vi.advanceTimersByTime(20));
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  writes = [];
  contentOffset = 500;
  observed = null;
  changeTab.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe() {}
      disconnect() {
        observed = null;
      }
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shouldLandOnArrival", () => {
  const base = { scrollRequested: false, hasMoment: false, firstArrival: true };
  it("lands on any explicit tool", () => {
    expect(shouldLandOnArrival({ ...base, tab: "urls" })).toBe(true);
    expect(shouldLandOnArrival({ ...base, tab: "recall", hasMoment: true })).toBe(true);
  });
  it("keeps the default entry on the live desktop", () => {
    expect(shouldLandOnArrival({ ...base, tab: "activity" })).toBe(false);
    expect(shouldLandOnArrival({ ...base, tab: "live" })).toBe(false);
  });
  it("lands on the Timeline only when asked, and never over a moment the Timeline scrolls to", () => {
    expect(shouldLandOnArrival({ ...base, tab: "activity", scrollRequested: true })).toBe(true);
    expect(
      shouldLandOnArrival({ ...base, tab: "activity", scrollRequested: true, hasMoment: true }),
    ).toBe(false);
  });
  it("goes back to the desktop on a later arrival at Live desktop", () => {
    expect(shouldLandOnArrival({ ...base, tab: "live", firstArrival: false })).toBe(true);
  });
});

describe("useToolLanding", () => {
  it("lands once, under the pinned bar, when a tool address is opened directly", async () => {
    await render({ tab: "urls" });
    expect(writes).toEqual([450]);
  });

  it("leaves the default entry and a plain Live desktop address at the top", async () => {
    await render({ tab: "activity" });
    expect(writes).toEqual([]);
    await render({ tab: "live", agentId: "a2" });
    expect(writes).toEqual([]);
  });

  it("lands when the address changes without a click (back, forward, palette)", async () => {
    await render({ tab: "activity" });
    await render({ tab: "keys" });
    expect(writes).toEqual([450]);
    await render({ tab: "live" });
    expect(writes).toEqual([450, 0]);
  });

  it("lands on the Timeline when the address asks for it", async () => {
    await render({ tab: "activity", scrollRequested: true });
    expect(writes).toEqual([450]);
  });

  it("does not scroll again when only the highlighted moment changes", async () => {
    await render({ tab: "alerts" });
    await render({ tab: "alerts", hasMoment: true });
    expect(writes).toEqual([450]);
  });

  it("scrolls once for a click, not again for the address change it causes", async () => {
    await render({ tab: "activity" });
    await act(async () => pick("windows"));
    await render({ tab: "windows" });
    expect(changeTab).toHaveBeenCalledWith("windows");
    expect(writes).toEqual([450]);
  });

  it("lands when the tool that is already open is picked again", async () => {
    await render({ tab: "files" });
    writes.length = 0;
    contentOffset = 900;
    await act(async () => pick("files"));
    await act(async () => void vi.advanceTimersByTime(20));
    expect(writes).toEqual([850]);
  });

  it("follows content that grows in late, then stops once the person scrolls", async () => {
    await render({ tab: "specs" });
    expect(writes).toEqual([450]);
    contentOffset = 800;
    await act(async () => observed?.());
    expect(writes).toEqual([450, 750]);
    await act(async () => void window.dispatchEvent(new Event("wheel")));
    expect(observed).toBeNull();
  });

  it("stops following after the settle time", async () => {
    await render({ tab: "specs" });
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(observed).toBeNull();
  });
});
