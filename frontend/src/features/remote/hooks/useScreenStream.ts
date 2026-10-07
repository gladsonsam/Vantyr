import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mjpegStreamUrl } from "@/api";
import type { DisplayedRemoteFrame } from "@/features/remote/hooks/useMjpegFrames";
import { useScreenStreamSource } from "@/features/remote/hooks/useScreenStreamSource";
import type { FrameReport } from "@/features/remote/lib/screenStreamSource";
import {
  STREAM_PRESET_TUNING,
  loadStreamPreset,
  saveStreamPreset,
  type StreamPreset,
} from "@/features/remote/lib/streamPresets";

/** A long gap between frames of a stream that should be live means it stalled. */
const STALL_AFTER_MS = 15_000;

/**
 * The live screen stream's lifecycle: a capture session per visit (rotated on reconnect,
 * quality/monitor change and return from a hidden tab), the viewer's quality preset
 * (remembered per browser) and monitor choice, frame status and stall detection. Frames come
 * from the injected {@link useScreenStreamSource} source.
 */
export function useScreenStream({
  agentId,
  streamEnabled,
  online,
  blockedByRole,
  onBeforeDisplay,
}: {
  agentId: string;
  /** The live view is on (tab visible, capture available). */
  streamEnabled: boolean;
  online: boolean;
  blockedByRole: boolean;
  onBeforeDisplay: (frame: DisplayedRemoteFrame | null) => void;
}) {
  const [streaming, setStreaming] = useState(false);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const lastFrameAtMsRef = useRef<number | null>(null);
  /** Latest abort — avoids effect cleanups tied to `abort` identity (session changes) clearing `<img src>`. */
  const abortRef = useRef<() => void>(() => {});

  /** Per visit to the screen tab; server ties MJPEG GET + explicit leave to this id. */
  const [session, setSession] = useState("");
  const sessionAgent = useRef(agentId);
  const [preset, setPreset] = useState<StreamPreset>(() => loadStreamPreset());
  /** Explicit monitor selection (0-based). `null` = let the agent pick its primary. */
  const [monitorIndex, setMonitorIndex] = useState<number | null>(null);

  const tuning = STREAM_PRESET_TUNING[preset];
  const streamUrl = useMemo(
    () => streamEnabled && sessionAgent.current === agentId && session
      ? mjpegStreamUrl(agentId, session, tuning, monitorIndex ?? undefined) : "",
    [streamEnabled, agentId, session, tuning, monitorIndex],
  );

  const source = useScreenStreamSource();
  const report = (status: FrameReport) => {
    setStreaming(status.streaming);
    setError(status.error);
    if (status.streaming) {
      setEverLoaded(true);
      lastFrameAtMsRef.current = Date.now();
    }
    // Lock the container to the remote screen's exact aspect ratio.
    if (status.size) setAspectRatio(`${status.size.width} / ${status.size.height}`);
  };
  const frames = source.useFrames({
    agentId,
    streamUrl,
    session,
    streamEnabled,
    enabled: streamEnabled && online && !blockedByRole,
    online,
    onBeforeDisplay,
    report,
  });

  // If we haven't seen a frame update in a while, treat as stalled.
  useEffect(() => {
    if (!streamEnabled || !frames.detectsStalls) {
      setStalled(false);
      return;
    }
    const t = window.setInterval(() => {
      const last = lastFrameAtMsRef.current;
      if (!last) {
        setStalled(false);
        return;
      }
      setStalled(Date.now() - last > STALL_AFTER_MS);
    }, 1000);
    return () => window.clearInterval(t);
  }, [streamEnabled, frames.detectsStalls]);

  // When the browser tab returns from being hidden, the MJPEG HTTP stream is
  // often broken (browsers throttle/drop long-lived connections for background
  // tabs). Rotate the session to force a fresh connection on return.
  useEffect(() => {
    if (!streamEnabled) return;
    let wasHidden = document.hidden;
    const onVisibility = () => {
      if (document.hidden) { wasHidden = true; return; }
      if (wasHidden) {
        wasHidden = false;
        setSession(crypto.randomUUID());
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [agentId, streamEnabled]);

  useEffect(() => {
    if (!streamEnabled || !online) { setSession(""); return; }
    sessionAgent.current = agentId;
    setSession(crypto.randomUUID());
  }, [agentId, streamEnabled, online]);

  useEffect(() => {
    // Reset status when stream toggles or agent changes.
    setStreaming(false);
    setEverLoaded(false);
    setError(false);
    setAspectRatio(null);
    setStalled(false);
    lastFrameAtMsRef.current = null;
  }, [agentId, streamEnabled, session]);

  // Drop any monitor selection when switching agents — indices aren't comparable
  // across machines, so fall back to the new agent's primary.
  useEffect(() => {
    setMonitorIndex(null);
  }, [agentId]);

  const { stop } = frames;
  /** Drop the stream and notify the server immediately so the agent gets `stop_capture` without waiting on the browser. */
  const abortNow = useCallback(() => {
    stop();
    setStreaming(false);
  }, [stop]);
  abortRef.current = abortNow;
  const abort = useCallback(() => abortRef.current(), []);

  useLayoutEffect(() => {
    if (!streamEnabled) abortRef.current();
  }, [streamEnabled]);
  useEffect(() => () => abortRef.current(), []);

  /** Start a fresh capture session (the server rejects a reused session id). */
  const restart = useCallback(() => setSession(crypto.randomUUID()), []);

  const changePreset = useCallback(
    (next: StreamPreset) => {
      setPreset(next);
      saveStreamPreset(next);
      // Rotate the session so the GET request picks up new tuning query params immediately.
      if (streamEnabled) restart();
    },
    [streamEnabled, restart],
  );

  const changeMonitor = useCallback(
    (next: number) => {
      setMonitorIndex(next);
      // Rotate the session so the new `?monitor=` param starts a fresh capture immediately.
      if (streamEnabled) restart();
    },
    [streamEnabled, restart],
  );

  return {
    source,
    frames,
    streamUrl,
    session,
    streaming,
    everLoaded,
    error,
    aspectRatio,
    stalled,
    preset,
    changePreset,
    monitorIndex,
    changeMonitor,
    abort,
    restart,
  };
}
