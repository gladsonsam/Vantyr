import { useCallback, useEffect, useState } from "react";

/** The non-standard `beforeinstallprompt` event (Chromium). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Whether the app is currently running as an installed/standalone PWA. */
function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mql = window.matchMedia?.("(display-mode: standalone)");
  // iOS Safari exposes `navigator.standalone` instead of the display-mode query.
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return Boolean(mql?.matches || iosStandalone);
}

/**
 * Captures the browser's `beforeinstallprompt` event so a custom "Install app"
 * button can trigger it later. `canInstall` is true only when the browser has
 * offered installation and the app isn't already installed.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(detectStandalone);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      // Prevent the default mini-infobar; we present our own button instead.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferred) return false;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    return choice.outcome === "accepted";
  }, [deferred]);

  return {
    /** True when the browser has offered install and the app isn't installed yet. */
    canInstall: Boolean(deferred) && !installed,
    /** True when the app is already running as an installed PWA. */
    installed,
    /** Trigger the native install prompt; resolves true if the user accepted. */
    promptInstall,
  };
}
