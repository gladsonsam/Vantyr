import { useCallback, useEffect, useRef } from "react";
import { notifyMjpegViewerLeft } from "@/api";
import { useMjpegFrames } from "@/features/remote/hooks/useMjpegFrames";
import { controlGeometryAvailable } from "@/features/remote/lib/remoteFrame";
import type { FrameSource, FrameSourceOptions, ScreenStreamSource } from "@/features/remote/lib/screenStreamSource";

/**
 * The agent's live desktop: a multipart MJPEG stream decoded onto a canvas. Every frame
 * carries capture geometry; input is only mapped (and stamped) against a verified one.
 */
function useMjpegFrameSource({ agentId, streamUrl, session, enabled, onBeforeDisplay, report }: FrameSourceOptions): FrameSource {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mjpeg = useMjpegFrames(streamUrl, enabled, canvasRef, {
    beforeDisplay: onBeforeDisplay,
    stopped: () => { if (session) notifyMjpegViewerLeft(agentId, session); },
  });
  const { getDisplayed, stop } = mjpeg;

  const reportRef = useRef(report);
  useEffect(() => { reportRef.current = report; });
  useEffect(() => {
    reportRef.current({
      streaming: Boolean(mjpeg.frame),
      error: Boolean(mjpeg.error),
      size: mjpeg.frame ? { width: mjpeg.frame.width, height: mjpeg.frame.height } : undefined,
    });
  }, [mjpeg.frame, mjpeg.error]);

  const surface = useCallback(() => {
    const element = canvasRef.current, frame = getDisplayed();
    return element && frame ? { getBoundingClientRect: () => element.getBoundingClientRect(), naturalWidth: frame.width, naturalHeight: frame.height } : null;
  }, [getDisplayed]);
  const leaseStamp = useCallback(() => {
    const g = getDisplayed()?.geometry;
    return controlGeometryAvailable(g) ? { capture_id: g.capture_id, geometry_revision: g.geometry_revision } : null;
  }, [getDisplayed]);

  const verifiedNow = useCallback(() => Boolean(getDisplayed()?.geometry?.desktop), [getDisplayed]);
  const inputStamp = useCallback(() => {
    const stamp = leaseStamp();
    return { ok: stamp !== null, stamp };
  }, [leaseStamp]);

  // Callbacks are stable: ScreenTab's input handlers depend on them.
  return {
    surface,
    // Server control requires a verified physical desktop rectangle. Missing
    // physical metadata keeps the entire real stream view-only.
    verified: controlGeometryAvailable(mjpeg.frame?.geometry),
    verifiedNow,
    inputStamp,
    leaseStamp,
    failed: Boolean(mjpeg.error),
    connecting: !mjpeg.frame,
    detectsStalls: true,
    selfLive: false,
    stop,
    render: ({ layout, streamEnabled, visible, transform }) =>
      layout === "embedded" ? (
        streamEnabled && streamUrl && (
          <canvas ref={canvasRef} role="img" aria-label="Agent screen" style={{ transform, position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: visible ? "block" : "none" }} />
        )
      ) : (
        <canvas ref={canvasRef} role="img" aria-label="Agent screen" className="vantyr-screen-image" style={{ transform, width: "100%", height: "100%", objectFit: "contain", display: visible ? "block" : "none" }} />
      ),
  };
}

export const mjpegScreenStreamSource: ScreenStreamSource = {
  useFrames: useMjpegFrameSource,
  audio: true,
};
