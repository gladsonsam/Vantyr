import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentEnrollmentSettings } from "@/features/enrollment/AgentEnrollmentSettings";

vi.mock("@/features/enrollment/EnrollmentTokenForm", () => ({
  EnrollmentTokenForm: ({ onGenerate }: { onGenerate: (body: { uses: number }) => Promise<void> }) =>
    <button onClick={() => void onGenerate({ uses: 1 })}>Generate test code</button>,
}));
vi.mock("@/features/enrollment/PendingApprovalsCard", () => ({ PendingApprovalsCard: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("keeps a newer pairing result when an older generation request fails", async () => {
  type Props = ComponentProps<typeof AgentEnrollmentSettings>;
  type Result = Awaited<ReturnType<Props["onGenerateToken"]>>;
  const old = deferred<Result>(), current = deferred<Result>();
  const generate = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const refresh = vi.fn().mockResolvedValue(undefined);
  const props: Props = {
    isAdmin: true, enrollClaims: [], enrollClaimsLoading: false,
    onRefreshClaims: refresh, onApproveClaim: vi.fn(), onRejectClaim: vi.fn(),
    enrollTokens: [], enrollTokensLoading: false, enrollTokensError: null,
    setEnrollTokensError: vi.fn(), loadEnrollmentTokens: refresh,
    onGenerateToken: generate, onRevokeToken: vi.fn(), onRevokeAllTokens: vi.fn(), onListTokenUses: vi.fn(),
  };
  await act(async () => root.render(<AgentEnrollmentSettings {...props} />));
  const button = Array.from(container.querySelectorAll("button")).find(element => element.textContent === "Generate test code")!;
  await act(async () => button.click());
  await act(async () => button.click());
  await act(async () => current.resolve({ enrollment_token: "222222", uses: 1, expires_at: null }));
  expect(container.textContent).toContain("222 222");
  await act(async () => old.reject(new Error("obsolete request failed")));
  expect(container.textContent).toContain("222 222");
  expect(container.textContent).not.toContain("obsolete request failed");
  expect(refresh).toHaveBeenCalledTimes(2);
});
