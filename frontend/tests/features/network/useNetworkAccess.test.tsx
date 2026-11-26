import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ApiError } from "@/api";

const api = { networkHouseholds: vi.fn() };
await vi.mock("@/api", () => ({ api }));

let role: "admin" | "operator" | "viewer" = "operator";
await vi.mock("@/app/providers/useSession", () => ({
  useSession: () => ({ user: { role } }),
}));

const { useNetworkAccess } = await import("@/features/network/access/useNetworkAccess");

function Probe() {
  const access = useNetworkAccess();
  return (
    <div data-state={access.state}>{access.state === "ready" ? access.household.name : ""}</div>
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  api.networkHouseholds.mockReset();
});

async function stateFor(result: () => Promise<unknown>) {
  api.networkHouseholds.mockImplementation(result);
  await act(async () => {
    root.render(withQueryClient(<Probe />, createTestQueryClient()));
  });
  await act(async () => {});
  return host.firstElementChild?.getAttribute("data-state");
}

describe("useNetworkAccess", () => {
  it("is unavailable when the server has no Network API", async () => {
    expect(await stateFor(async () => Promise.reject(new ApiError("Not found", 404)))).toBe(
      "unavailable",
    );
  });

  it("is denied on a 403", async () => {
    expect(await stateFor(async () => Promise.reject(new ApiError("Forbidden", 403)))).toBe(
      "denied",
    );
  });

  it("never grants access from the dashboard role: an operator with no household is denied", async () => {
    role = "operator";
    expect(await stateFor(async () => ({ households: [] }))).toBe("denied");
  });

  it("offers first-time setup only to a platform admin", async () => {
    role = "admin";
    expect(await stateFor(async () => ({ households: [] }))).toBe("setup");
  });

  it("is ready, preferring the default household", async () => {
    role = "operator";
    const state = await stateFor(async () => ({
      households: [
        { id: "a", name: "Other", is_default: false, created_at: "2026-01-01T00:00:00Z" },
        { id: "b", name: "Home", is_default: true, created_at: "2026-01-01T00:00:00Z" },
      ],
    }));
    expect(state).toBe("ready");
    expect(host.textContent).toBe("Home");
  });

  it("reports other failures as an error, not as missing access", async () => {
    expect(await stateFor(async () => Promise.reject(new ApiError("Boom", 500)))).toBe("error");
  });
});
