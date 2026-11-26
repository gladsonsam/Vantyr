import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NetworkOverviewPage } from "@/features/network/overview/NetworkOverviewPage";
import {
  NetworkRuntimeContext,
  unavailableRuntime,
  type NetworkRuntimeSource,
} from "@/features/network/runtime/NetworkRuntimeSource";
import type { NetworkOverview } from "@/features/network/runtime/types";

// The revision numbers count up with motion's `inView`, which needs IntersectionObserver.
class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: StubIntersectionObserver,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(runtime: NetworkRuntimeSource) {
  await act(async () => {
    root.render(
      withQueryClient(
        <MemoryRouter>
          <NetworkRuntimeContext.Provider value={runtime}>
            <NetworkOverviewPage />
          </NetworkRuntimeContext.Provider>
        </MemoryRouter>,
        createTestQueryClient(),
      ),
    );
  });
  await act(async () => {});
}

const overview = (over: Partial<NetworkOverview> = {}): NetworkOverview => ({
  timezone: "UTC",
  revisions: { applied: 14, proposal: 15, proposalSavedAt: new Date().toISOString() },
  gateways: [
    {
      id: "g",
      kind: "dns",
      name: "Vantyr DNS",
      online: false,
      lastSeenAt: null,
      appliedRevision: 14,
      acknowledgedAt: null,
      verification: "unverified",
      verifiedAt: null,
      capabilities: [{ id: "dns_filtering", coverage: "offline" }],
      warnings: [],
    },
  ],
  ...over,
});

describe("NetworkOverviewPage", () => {
  it("says so, and shows no status, when the server has no gateway API", async () => {
    await render(unavailableRuntime);
    expect(host.textContent).toContain("does not provide the Vantyr Network gateway API");
    expect(host.textContent).not.toContain("Enforced");
    expect(host.textContent).not.toContain("Online");
  });

  it("separates a saved proposal from what is applied", async () => {
    await render({
      ...unavailableRuntime,
      overview: async () => ({ state: "ready", data: overview() }),
    });
    expect(host.textContent).toContain("Gateways are still enforcing revision 14");
    expect(host.textContent).toContain("revision 15 is not in force");
  });

  it("claims no enforcement when nothing has been applied", async () => {
    await render({
      ...unavailableRuntime,
      overview: async () => ({
        state: "ready",
        data: overview({ revisions: { applied: null, proposal: null, proposalSavedAt: null } }),
      }),
    });
    expect(host.textContent).toContain("nothing is being enforced");
  });

  it("never turns an offline gateway into an enforced one", async () => {
    await render({
      ...unavailableRuntime,
      overview: async () => ({ state: "ready", data: overview() }),
    });
    expect(host.textContent).toContain("Offline");
    expect(host.textContent).not.toContain("Enforced");
    expect(host.textContent).toContain("Not verified");
  });
});
