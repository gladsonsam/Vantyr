import { useCallback, useRef } from "react";
import type { FrameSource, FrameSourceOptions, ScreenStreamSource } from "@/features/remote/lib/screenStreamSource";
import { DemoScreen } from "./DemoScreen";

const alwaysVerified = () => true;
const unstamped = () => ({ ok: true, stamp: null });

/**
 * Demo mode has no MJPEG backend: show a believable fake desktop instead of a perpetual
 * "Connecting…" placeholder. A placeholder image (the demo stream URL) still drives load state
 * and pointer mapping, invisible over the mock desktop. There is no capture geometry, so input
 * is never stamped and the display always counts as verified.
 */
function useDemoFrameSource({ agentId, streamUrl, session, streamEnabled, online, report }: FrameSourceOptions): FrameSource {
  const imgRef = useRef<HTMLImageElement>(null);

  const onLoad = () => {
    if (!streamEnabled) return;
    const img = imgRef.current;
    const size = img && img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : undefined;
    report({ streaming: true, error: false, size });
  };
  const onError = () => report({ streaming: false, error: true });

  // Stable callbacks: ScreenTab's input handlers depend on them.
  const surface = useCallback(() => imgRef.current, []);
  const stop = useCallback(() => {
    const el = imgRef.current;
    if (el) {
      el.removeAttribute("src");
      el.src = "";
      el.removeAttribute("srcset");
    }
  }, []);

  return {
    surface,
    verified: true,
    verifiedNow: alwaysVerified,
    inputStamp: unstamped,
    failed: false,
    connecting: false,
    detectsStalls: false,
    selfLive: online,
    stop,
    render: ({ layout, streamEnabled: enabled, visible, transform }) =>
      layout === "embedded" ? (
        <>
          {online && <DemoScreen agentId={agentId} />}
          {enabled && streamUrl && (
            <img
              key={`${agentId}-mjpeg-${session}`}
              ref={imgRef}
              src={streamUrl}
              alt="Agent screen"
              onLoad={onLoad}
              onError={onError}
              style={{ transform, position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: visible ? "block" : "none", ...(online ? { opacity: 0 } : {}) }}
            />
          )}
        </>
      ) : (
        <img
          key={enabled && session ? `${agentId}-mjpeg-${session}` : `${agentId}-mjpeg-off`}
          ref={imgRef}
          src={enabled ? streamUrl : ""}
          alt="Agent screen"
          className="vantyr-screen-image"
          style={{ transform }}
          onLoad={onLoad}
          onError={onError}
        />
      ),
  };
}

export const demoScreenStreamSource: ScreenStreamSource = {
  useFrames: useDemoFrameSource,
  audio: false,
  audioNote: "No audio in demo.",
};
