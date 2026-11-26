import { useCallback, useEffect, useRef, useState } from "react";
import { keyboardLockApi, keyboardLockFailure, keyboardLockSuperseded, remoteShortcutHint, type KeyboardLockStatus } from "@/features/remote/lib/keyboardLock";

type Outcome = "locked" | "denied" | "failed";

/**
 * Holds the browser's keyboard lock while `wanted` is true (native fullscreen with an active control
 * lease) so Ctrl+W / Ctrl+T reach the remote desktop. Every way `wanted` goes false (fullscreen
 * exit, control released, lease lost, device offline, unmount) unlocks. A lock() that resolves
 * after its request was withdrawn unlocks again instead of leaving the browser locked.
 */
export function useKeyboardLock(wanted: boolean): { status: KeyboardLockStatus; retry: () => void } {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attemptRound, setAttemptRound] = useState(0);
  const [wasWanted, setWasWanted] = useState(wanted);
  // A new request starts without the previous request's verdict; derive that during render.
  if (wasWanted !== wanted) {
    setWasWanted(wanted);
    setOutcome(null);
  }
  /** Id of the request whose result may still be applied; null once none is wanted. */
  const live = useRef<number | null>(null);
  const counter = useRef(0);
  const unsupported = wanted && keyboardLockApi() === null;

  useEffect(() => {
    const api = keyboardLockApi();
    if (!wanted || !api) return;
    const id = ++counter.current;
    live.current = id;
    api.lock().then(
      () => {
        if (live.current === id) setOutcome("locked");
        else if (live.current === null) api.unlock(); // withdrawn while the prompt/lock was pending
      },
      (error: unknown) => {
        if (live.current !== id || keyboardLockSuperseded(error)) return;
        setOutcome(keyboardLockFailure(error));
      },
    );
    return () => {
      live.current = null;
      api.unlock();
    };
  }, [wanted, attemptRound]);

  /** Try again after a failure that is not a refusal; needs a fresh user gesture (a click on the screen). */
  const retry = useCallback(() => {
    if (outcome !== "failed") return;
    setOutcome(null);
    setAttemptRound(round => round + 1);
  }, [outcome]);

  const status: KeyboardLockStatus = !wanted ? "idle" : unsupported ? "unsupported" : outcome ?? "locking";
  return { status, retry };
}

/**
 * Keyboard capture for the live screen: browser shortcuts (Ctrl+W, Ctrl+T) are captured only while
 * native fullscreen and a held control lease coincide, so viewers and read-only roles never get it.
 * Returns the toolbar hint, the Fullscreen button's tooltip, and the retry for a click on the screen.
 */
export function useRemoteKeyboardCapture({ controlling, canControl, nativeFullscreen, pseudoFs }: {
  controlling: boolean; canControl: boolean; nativeFullscreen: boolean; pseudoFs: boolean;
}) {
  const { status, retry } = useKeyboardLock(nativeFullscreen && controlling);
  const hint = remoteShortcutHint({ controlling, canControl, nativeFullscreen, maximized: nativeFullscreen || pseudoFs, lock: status });
  const canOfferCapture = controlling && !nativeFullscreen && !pseudoFs && keyboardLockApi() !== null;
  return { hint, retry, fullscreenTitle: canOfferCapture ? "Fullscreen. Also sends browser shortcuts like Ctrl+W to this desktop." : undefined };
}
