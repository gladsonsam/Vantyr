import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauriRuntime()) {
    return Promise.reject(new Error("Tauri IPC unavailable"));
  }
  return tauriInvoke<T>(cmd, args);
}

export function listen<T>(
  event: string,
  handler: (event: { event: string; id: number; payload: T }) => void,
): Promise<() => void> {
  if (!hasTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return tauriListen<T>(event, handler);
}
