import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mjpegStreamUrl } from "@/api";
import { tuneScreenStream } from "@/api/endpoints/remote";
import { StreamTuningQueue } from "../lib/streamTuningQueue";
import { AutoStreamController } from "../lib/streamMetrics";
import type { DisplayedRemoteFrame } from "@/features/remote/hooks/useMjpegFrames";
import { useScreenStreamSource } from "@/features/remote/hooks/useScreenStreamSource";
import type { FrameReport } from "@/features/remote/lib/screenStreamSource";
import {
  resolveStreamTuning,
  loadStreamPreset,
  saveStreamPreset,
  type StreamPreset,
} from "@/features/remote/lib/streamPresets";

/** A long gap between frames of a stream that should be live means it stalled. */
const STALL_AFTER_MS = 15_000;

/**
 * The live screen stream's lifecycle: a capture session per visit (rotated on reconnect,
 * monitor change and return from a hidden tab), the viewer's quality preset
 * (remembered per browser) and monitor choice, frame status and stall detection. Frames come
 * from the injected {@link useScreenStreamSource} source.
 */
export function useScreenStream({
  agentId,
  videoEnabled = false,
  streamEnabled,
  online,
  blockedByRole,
  onBeforeDisplay,
}: {
  agentId: string;
  videoEnabled?: boolean;
  /** The live view is on (tab visible, capture available). */
  streamEnabled: boolean;
  online: boolean;
  blockedByRole: boolean;
  onBeforeDisplay: (frame: DisplayedRemoteFrame | null) => void;
}) {
  const useVideo = videoEnabled && typeof VideoDecoder !== "undefined";
  const [streaming, setStreaming] = useState(false);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const lastFrameAtMsRef = useRef<number | null>(null);
  /** Latest abort — avoids effect cleanups tied to `abort` identity (session changes) clearing `<img src>`. */
  const abortRef = useRef<() => void>(() => {});

  const sessionScope = `${agentId}:${streamEnabled}:${online}:${useVideo}`;
  const [session, setSession] = useStreamSession(sessionScope, streamEnabled && online);
  const [preset, setPreset] = useState<StreamPreset>(() => loadStreamPreset());
  /** Explicit monitor selection (0-based). `null` = let the agent pick its primary. */
  const [monitorIndex, setMonitorIndex] = useState<number | null>(null);

  const [autoTier, setAutoTier] = useState(2);
  const controller = useMemo(
    () => new AutoStreamController(`${session}:${preset}`),
    [session, preset],
  );
  const tuning = useMemo(
    () => resolveStreamTuning(preset, autoTier, useVideo),
    [preset, autoTier, useVideo],
  );
  // Initial query is stable for the lifetime of the session. All later tuning
  // uses POST, so neither transport cleanup nor lease release runs.
  const [initial, setInitial] = useState(() => ({
    session,
    tuning: resolveStreamTuning(preset, 2, useVideo),
  }));
  if (initial.session !== session)
    setInitial({ session, tuning: resolveStreamTuning(preset, 2, useVideo) });
  const initialTuning = initial.tuning;
  const [previousController, setPreviousController] = useState(controller);
  if (previousController !== controller) {
    setPreviousController(controller);
    setAutoTier(2);
  }
  useEffect(() => {
    controller.reset(Date.now());
    if (preset !== "auto") return;
    const timer = window.setInterval(() => {
      setAutoTier(
        controller.sample(
          Date.now(),
          resolveStreamTuning("auto", controller.tier, useVideo).intervalMs,
        ),
      );
    }, 2000);
    return () => window.clearInterval(timer);
  }, [controller, preset, useVideo]);
  const tuningQueue = useMemo(() => new StreamTuningQueue(), []);
  const [failedTuning, setFailedTuning] = useState<{
    session: string;
    tuning: typeof tuning;
  } | null>(null);
  const tuningError = failedTuning?.session === session && failedTuning.tuning === tuning;
  const appliedTuning = useRef({ session: "", tuning: initialTuning });
  useEffect(() => {
    if (!session || !streamEnabled || !online || blockedByRole) return;
    if (appliedTuning.current.session !== session)
      appliedTuning.current = { session, tuning: initialTuning };
    // Always queue the latest value: an earlier in-flight request may still settle.
    return tuningQueue.enqueue(
      async () => {
        const applied = appliedTuning.current;
        if (
          applied.session === session &&
          tuning.jpegQ === applied.tuning.jpegQ &&
          tuning.intervalMs === applied.tuning.intervalMs
        )
          return;
        await tuneScreenStream(agentId, session, tuning);
        if (appliedTuning.current.session === session) appliedTuning.current = { session, tuning };
      },
      () => setFailedTuning({ session, tuning }),
    );
  }, [agentId, session, streamEnabled, online, blockedByRole, tuning, initialTuning, tuningQueue]);
  const streamUrl = useMemo(
    () =>
      streamEnabled && session
        ? mjpegStreamUrl(agentId, session, initialTuning, monitorIndex ?? undefined)
        : "",
    [streamEnabled, agentId, session, initialTuning, monitorIndex],
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
    videoEnabled,
    streamUrl,
    session,
    streamEnabled,
    enabled: streamEnabled && online && !blockedByRole,
    online,
    onBeforeDisplay,
    report,
    metrics: controller,
  });

  useStreamStall(streamEnabled, frames.detectsStalls, lastFrameAtMsRef, setStalled);

  // Reset status when stream toggles or agent changes. The flags derive during
  // render; the effect below only clears the frame timestamp ref.
  const [prevStatusScope, setPrevStatusScope] = useState({ agentId, streamEnabled, session });
  if (
    prevStatusScope.agentId !== agentId ||
    prevStatusScope.streamEnabled !== streamEnabled ||
    prevStatusScope.session !== session
  ) {
    setPrevStatusScope({ agentId, streamEnabled, session });
    setStreaming(false);
    setEverLoaded(false);
    setError(false);
    setAspectRatio(null);
    setStalled(false);
  }
  useEffect(() => {
    lastFrameAtMsRef.current = null;
  }, [agentId, streamEnabled, session]);

  // Drop any monitor selection when switching agents — indices aren't comparable
  // across machines, so fall back to the new agent's primary.
  const [prevMonitorAgent, setPrevMonitorAgent] = useState(agentId);
  if (prevMonitorAgent !== agentId) {
    setPrevMonitorAgent(agentId);
    setMonitorIndex(null);
  }

  const { stop } = frames;
  /** Drop the stream and notify the server immediately so the agent gets `stop_capture` without waiting on the browser. */
  const abortNow = useCallback(() => {
    stop();
    setStreaming(false);
  }, [stop]);
  // The layout effect and unmount cleanup below read this between renders;
  // mirror the latest callback here so they never close over a stale one.
  useEffect(() => {
    abortRef.current = abortNow;
  });
  const abort = useCallback(() => abortRef.current(), []);

  useLayoutEffect(() => {
    if (!streamEnabled) abortRef.current();
  }, [streamEnabled]);
  useEffect(() => () => abortRef.current(), []);

  /** Start a fresh capture session (the server rejects a reused session id). */
  const restart = useCallback(() => setSession(crypto.randomUUID()), [setSession]);

  const changePreset = useCallback((next: StreamPreset) => {
    setPreset(next);
    saveStreamPreset(next);
  }, []);

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
    error: error || tuningError,
    tuningError,
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

/** Own the server session identity and rotate it on visible-tab reentry. */
function useStreamSession(scope: string, enabled: boolean) {
  const [session, setSession] = useState(() => (enabled ? crypto.randomUUID() : ""));
  const [previous, setPrevious] = useState(scope);
  if (previous !== scope) {
    setPrevious(scope);
    setSession(enabled ? crypto.randomUUID() : "");
  }
  useEffect(() => {
    if (!enabled) return;
    let wasHidden = document.hidden;
    const onVisibility = () => {
      if (document.hidden) {
        wasHidden = true;
        return;
      }
      if (wasHidden) {
        wasHidden = false;
        setSession(crypto.randomUUID());
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [scope, enabled]);
  return [session, setSession] as const;
}

function useStreamStall(
  enabled: boolean,
  detectsStalls: boolean,
  lastFrame: React.RefObject<number | null>,
  setStalled: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const scope = `${enabled}:${detectsStalls}`;
  const [previous, setPrevious] = useState(scope);
  if (previous !== scope) {
    setPrevious(scope);
    setStalled(false);
  }
  useEffect(() => {
    if (!enabled || !detectsStalls) return;
    const timer = window.setInterval(() => {
      const last = lastFrame.current;
      setStalled(last !== null && Date.now() - last > STALL_AFTER_MS);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [enabled, detectsStalls, lastFrame, setStalled]);
}
