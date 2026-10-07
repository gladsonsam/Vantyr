// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DashboardSessionUser } from "@/api/types";
import { SessionProvider } from "./SessionProvider";
import { useSession, type SessionContextValue } from "./useSession";

const apiMock = vi.hoisted(() => ({
  authStatus: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
  setDashboardCsrfToken: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: { authStatus: apiMock.authStatus, me: apiMock.me, logout: apiMock.logout },
  setDashboardCsrfToken: apiMock.setDashboardCsrfToken,
}));

const admin: DashboardSessionUser = { id: "u1", username: "admin", role: "admin", csrf_token: "csrf-123" };

let session: SessionContextValue | null = null;
function Probe() {
  session = useSession();
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
  await act(async () => root.render(<SessionProvider><Probe /></SessionProvider>));
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
