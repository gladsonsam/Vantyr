import { requestJson, csrfHeaders, apiUrl } from "@/api/client";
import { isDemoMode } from "@/demo/mode";

export type MjpegStreamTuning = {
  jpegQ: number;
  intervalMs: number;
};

/** Multipart MJPEG URL; `session` must match {@link notifyMjpegViewerLeft}. `monitor` is a 0-based index (omit for primary). */
export function mjpegStreamUrl(agentId: string, session: string, tuning?: MjpegStreamTuning, monitor?: number): string {
  if (isDemoMode) {
    const label = encodeURIComponent(`Vantyr demo stream - ${agentId}`);
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1280 720'%3E%3Crect width='1280' height='720' fill='%230b0c0f'/%3E%3Cpath d='M0 80h1280M0 160h1280M0 240h1280M0 320h1280M0 400h1280M0 480h1280M0 560h1280M0 640h1280M160 0v720M320 0v720M480 0v720M640 0v720M800 0v720M960 0v720M1120 0v720' stroke='%2322262e' stroke-width='2'/%3E%3Crect x='390' y='255' width='500' height='210' rx='24' fill='%2315171c' stroke='%233b82f6' stroke-opacity='.45'/%3E%3Ctext x='640' y='345' text-anchor='middle' fill='%23eceef1' font-family='Segoe UI, sans-serif' font-size='36' font-weight='700'%3EVantyr demo stream%3C/text%3E%3Ctext x='640' y='395' text-anchor='middle' fill='%23a4a8b2' font-family='Consolas, monospace' font-size='22'%3E${label}%3C/text%3E%3C/svg%3E`;
  }
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
  if (isDemoMode) return;
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
