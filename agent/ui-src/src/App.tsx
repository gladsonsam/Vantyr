import { useCallback, useEffect, useState } from "react";
import { PasswordGate } from "./components/PasswordGate";
import { SettingsPanel } from "./components/SettingsPanel";
import { Spinner } from "./components/AgentUi";
import { useSystemColorScheme } from "./hooks/useSystemColorScheme";
import { invoke, listen } from "./lib/tauri";
import type { AppScreen } from "./types";

export default function App() {
  useSystemColorScheme();

  const [screen, setScreen] = useState<AppScreen>("loading");

  const checkLock = useCallback(() => {
    invoke<boolean>("has_ui_password")
      .then((has) => setScreen(has ? "password" : "settings"))
      .catch(() => setScreen("settings"));
  }, []);

  const forceRelock = useCallback(() => {
    setScreen("password");
    checkLock();
  }, [checkLock]);

  useEffect(() => {
    checkLock();

    const unlistenLock = listen("lock_ui", () => {
      forceRelock();
    });

    return () => {
      unlistenLock.then((unlisten: () => void) => unlisten());
    };
  }, [checkLock, forceRelock]);

  if (screen === "loading") {
    return (
      <main className="agent-loading">
        <Spinner size={26} />
      </main>
    );
  }

  if (screen === "password") {
    return <PasswordGate onUnlock={() => setScreen("settings")} />;
  }

  return <SettingsPanel />;
}
