import { testMock as vi } from "@tests/support/mock";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "bun:test";

await vi.mock("@/features/enrollment/EnrollmentTokenForm", () => ({
  EnrollmentTokenForm: ({
    onGenerate,
    extra,
  }: {
    onGenerate: (body: { uses: number }) => Promise<void>;
    extra?: ReactNode;
  }) => (
    <>
      <button onClick={() => void onGenerate({ uses: 1 })}>Generate test code</button>
      {extra}
    </>
  ),
}));
await vi.mock("@/features/enrollment/PendingApprovalsCard", () => ({
  PendingApprovalsCard: () => null,
}));
await vi.mock("@/features/enrollment/PairingCodeList", () => ({
  PairingCodeList: () => <div>Code list</div>,
}));
const { AgentEnrollmentSettings } = await import("@/features/enrollment/AgentEnrollmentSettings");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps a newer pairing result when an older generation request fails", async () => {
  type Props = ComponentProps<typeof AgentEnrollmentSettings>;
  type Result = Awaited<ReturnType<Props["onGenerateToken"]>>;
  const old = deferred<Result>(),
    current = deferred<Result>();
  const generate = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const refresh = vi.fn().mockResolvedValue(undefined);
  const props: Props = {
    isAdmin: true,
    enrollClaims: [],
    enrollClaimsLoading: false,
    onRefreshClaims: refresh,
    onApproveClaim: vi.fn(),
    onRejectClaim: vi.fn(),
    enrollTokens: [],
    enrollTokensLoading: false,
    enrollTokensError: null,
    setEnrollTokensError: vi.fn(),
    loadEnrollmentTokens: refresh,
    onGenerateToken: generate,
    onRevokeToken: vi.fn(),
    onRevokeAllTokens: vi.fn(),
    onListTokenUses: vi.fn(),
  };
  await act(async () => root.render(<AgentEnrollmentSettings {...props} />));
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === "Generate test code",
  )!;
  await act(async () => button.click());
  await act(async () => button.click());
  await act(async () => current.resolve({ enrollment_token: "222222", uses: 1, expires_at: null }));
  expect(container.textContent).toContain("222 222");
  await act(async () => old.reject(new Error("obsolete request failed")));
  expect(container.textContent).toContain("222 222");
  expect(container.textContent).not.toContain("obsolete request failed");
  expect(refresh).toHaveBeenCalledTimes(2);
});

function baseProps(): ComponentProps<typeof AgentEnrollmentSettings> {
  const refresh = vi.fn().mockResolvedValue(undefined);
  return {
    isAdmin: true,
    enrollClaims: [],
    enrollClaimsLoading: false,
    onRefreshClaims: refresh,
    onApproveClaim: vi.fn(),
    onRejectClaim: vi.fn(),
    enrollTokens: [],
    enrollTokensLoading: false,
    enrollTokensError: null,
    setEnrollTokensError: vi.fn(),
    loadEnrollmentTokens: refresh,
    onGenerateToken: vi
      .fn()
      .mockResolvedValue({ enrollment_token: "123456", uses: 1, expires_at: null }),
    onRevokeToken: vi.fn(),
    onRevokeAllTokens: vi.fn(),
    onListTokenUses: vi.fn(),
  };
}
const generate = async () => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === "Generate test code",
  )!;
  await act(async () => button.click());
};

it("says a failed approval check failed, with a way to retry", async () => {
  const props = { ...baseProps(), enrollClaimsError: "boom" };
  await act(async () => root.render(<AgentEnrollmentSettings {...props} />));
  expect(container.textContent).toContain("Couldn't check for devices waiting for approval. boom");
  const retry = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === "Try again",
  )!;
  await act(async () => retry.click());
  expect(props.onRefreshClaims).toHaveBeenCalled();
});

it("shows nothing to non-admins", async () => {
  await act(async () => root.render(<AgentEnrollmentSettings {...baseProps()} isAdmin={false} />));
  expect(container.textContent).toBe("");
});

it("shows the new code once, with its uses and the warning that it is not shown again", async () => {
  const props = baseProps();
  await act(async () => root.render(<AgentEnrollmentSettings {...props} />));
  expect(container.textContent).toContain(
    "Generate a pairing code and enter it on the new device.",
  );
  await generate();
  expect(container.textContent).toContain("123 456");
  expect(container.textContent).toContain("1 use · no expiry");
  expect(container.textContent).toContain("the list below never shows the code again");
  expect(props.onGenerateToken).toHaveBeenCalledWith({ uses: 1 });
});

it("says the clipboard refused instead of failing silently", async () => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  await act(async () => root.render(<AgentEnrollmentSettings {...baseProps()} />));
  await generate();
  const copy = Array.from(container.querySelectorAll("button")).find((element) =>
    element.textContent?.includes("Copy code"),
  )!;
  await act(async () => copy.click());
  expect(container.textContent).toContain("Couldn't copy automatically.");
});

it("says why a code could not be made", async () => {
  const props = baseProps();
  props.onGenerateToken = vi.fn().mockRejectedValue(new Error("too many codes"));
  await act(async () => root.render(<AgentEnrollmentSettings {...props} />));
  await generate();
  expect(container.textContent).toContain("Couldn't generate a code. too many codes");
});
