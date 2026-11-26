import { withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "bun:test";
import type { DashboardSessionUser } from "@/api/types";

import type { SessionContextValue } from "@/app/providers/useSession";

const apiMock = (() => ({
  authStatus: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
  setDashboardCsrfToken: vi.fn(),
}))();

await vi.mock("@/api", () => ({
  api: { authStatus: apiMock.authStatus, me: apiMock.me, logout: apiMock.logout },
  setDashboardCsrfToken: apiMock.setDashboardCsrfToken,
}));

const { SessionProvider } = await import("@/app/providers/SessionProvider");
const { useSession } = await import("@/app/providers/useSession");

const admin: DashboardSessionUser = {
  id: "u1",
  username: "admin",
  role: "admin",
  display_name: "",
  display_icon: null,
  csrf_token: "csrf-123",
};

let session: SessionContextValue | null = null;
function Probe() {
  const value = useSession();
  useEffect(() => {
    session = value;
  }, [value]);
  return null;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  session = null;
  vi.clearAllMocks();
});

it("loads the user and CSRF token right after an in-app login", async () => {
  apiMock.authStatus.mockResolvedValueOnce({ authenticated: false });
  await act(async () =>
    root.render(
      withQueryClient(
        <SessionProvider>
          <Probe />
        </SessionProvider>,
      ),
    ),
  );
  expect(session?.authenticated).toBe(false);
  expect(session?.user).toBeNull();
  expect(apiMock.me).not.toHaveBeenCalled();

  apiMock.authStatus.mockResolvedValueOnce({ authenticated: true });
  apiMock.me.mockResolvedValueOnce(admin);
  await act(async () => session!.completeLogin());

  expect(session?.authenticated).toBe(true);
  expect(session?.user).toEqual(admin);
  expect(session?.navUser?.username).toBe("admin");
  expect(apiMock.setDashboardCsrfToken).toHaveBeenLastCalledWith("csrf-123");
});
