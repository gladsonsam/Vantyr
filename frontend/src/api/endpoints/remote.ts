import { requestJson, csrfHeaders, apiUrl } from "@/api/client";

export type MjpegStreamTuning = {
  jpegQ: number;
  intervalMs: number;
};

/** Multipart MJPEG URL; `session` must match {@link notifyMjpegViewerLeft}. `monitor` is a 0-based index (omit for primary). */
export function mjpegStreamUrl(agentId: string, session: string, tuning?: MjpegStreamTuning, monitor?: number): string {
  const qs = new URLSearchParams();
  qs.set("session", session);
  if (tuning) {
    qs.set("jpeg_q", String(tuning.jpegQ));
    qs.set("interval_ms", String(tuning.intervalMs));
  }
  if (monitor != null) {
    qs.set("monitor", String(monitor));
  }
  return apiUrl(`/agents/${agentId}/mjpeg?${qs.toString()}`);
}

/** Tell the server this dashboard tab stopped viewing live screen (sends `stop_capture` when last viewer). */
export function notifyMjpegViewerLeft(agentId: string, session: string): void {
  if (!session) return;
  void fetch(apiUrl(`/agents/${agentId}/mjpeg/leave`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({ session }),
    credentials: "include",
    keepalive: true,
  }).catch(() => {
    /* best-effort */
  });
}

export type ClipboardRequest = { action: "read"; control_token: string } | { action: "write"; control_token: string; text: string };
export interface ClipboardReply { ok: true; text?: string }

export const remoteEndpoints = {
  agentClipboard: (agentId: string, body: ClipboardRequest, signal?: AbortSignal): Promise<ClipboardReply> => requestJson(`/agents/${encodeURIComponent(agentId)}/clipboard`, {
    method: "POST", headers: { "Content-Type": "application/json", ...csrfHeaders() }, body: JSON.stringify(body), signal,
  }),
};
