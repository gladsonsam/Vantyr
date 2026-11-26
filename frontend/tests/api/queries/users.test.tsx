import { useLayoutEffect } from "react";
import { createTestQueryClient, withQueryClient } from "@tests/support/queryClient";
import { testMock as vi } from "@tests/support/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "bun:test";

const api = (() => ({
  userDelete: vi.fn(async () => ({ ok: true })),
  userIdentityLink: vi.fn(async () => ({ ok: true })),
}))();
await vi.mock("@/api", () => ({ api }));

const { authKeys } = await import("@/api/queries/auth");
const { useDeleteUserMutation, useLinkIdentityMutation, userKeys } =
  await import("@/api/queries/users");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.clearAllMocks();
});

async function run<T>(
  useHook: () => T,
  use: (hook: T) => Promise<unknown>,
  client = createTestQueryClient(),
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let current!: T;
  function Probe() {
    const committedValue = useHook();
    useLayoutEffect(() => {
      current = committedValue;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(async () => root.render(withQueryClient(<Probe />, client)));
  await act(async () => {
    await use(current);
  });
  return client;
}

describe("user mutations", () => {
  it("deleting a user reloads the signed-in user and the directory, after onDeleted", async () => {
    const client = createTestQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const onDeleted = vi.fn(() => expect(invalidate).not.toHaveBeenCalled());
    await run(
      () => useDeleteUserMutation({ onDeleted }),
      (m) => m.mutateAsync("u1"),
      client,
    );
    expect(api.userDelete).toHaveBeenCalledWith("u1");
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
      authKeys.me(),
      userKeys.list(),
    ]);
  });

  it("linking an identity reloads only that user's identities", async () => {
    const client = createTestQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await run(
      () => useLinkIdentityMutation(),
      (m) => m.mutateAsync({ userId: "u2", identity: { issuer: "https://idp", subject: "abc" } }),
      client,
    );
    expect(api.userIdentityLink).toHaveBeenCalledWith("u2", {
      issuer: "https://idp",
      subject: "abc",
    });
    expect(invalidate.mock.calls.map((c) => c[0]?.queryKey)).toEqual([userKeys.identities("u2")]);
  });
});
