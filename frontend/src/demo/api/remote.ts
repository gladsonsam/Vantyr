import type { ApiClient } from "@/api";
import { asRecord } from "./helpers";
import type { DemoState } from "./state";

/** Fake device clipboard endpoint (an in-memory clipboard per device). */
export function demoRemoteApi(state: DemoState): Partial<ApiClient> {
  const { clipboard, moduleStatus } = state;
  return {
    agentClipboard: async (id, body, signal) => {
      if ((signal as AbortSignal | undefined)?.aborted) throw new DOMException("Aborted", "AbortError");
      const input = asRecord(body), device = String(id), status = moduleStatus(device);
      if (!status.online || !input.control_token || !status.state?.modules.some(m => m.module === "clipboard" && m.available && m.enabled)) throw new Error("Simulated clipboard permission unavailable");
      if (input.action === "read") return { ok: true, text: clipboard.get(device) ?? "Simulated device clipboard text" };
      if (input.action !== "write" || typeof input.text !== "string" || new TextEncoder().encode(input.text).byteLength > 65536) throw new Error("Clipboard text exceeds 64 KiB");
      clipboard.set(device, input.text);
      return { ok: true };
    },
  };
}
