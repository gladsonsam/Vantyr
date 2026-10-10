import { useCallback, useRef } from "react";
import type { FrameSource, FrameSourceOptions, ScreenStreamSource } from "@/features/remote/lib/screenStreamSource";
import { DemoScreen } from "./DemoScreen";

/** Placeholder image for the demo stream: it drives load state and pointer mapping, invisible over the mock desktop. */
function demoStreamUrl(agentId: string): string {
  const label = encodeURIComponent(`Vantyr demo stream - ${agentId}`);
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1280 720'%3E%3Crect width='1280' height='720' fill='%230b0c0f'/%3E%3Cpath d='M0 80h1280M0 160h1280M0 240h1280M0 320h1280M0 400h1280M0 480h1280M0 560h1280M0 640h1280M160 0v720M320 0v720M480 0v720M640 0v720M800 0v720M960 0v720M1120 0v720' stroke='%2322262e' stroke-width='2'/%3E%3Crect x='390' y='255' width='500' height='210' rx='24' fill='%2315171c' stroke='%233b82f6' stroke-opacity='.45'/%3E%3Ctext x='640' y='345' text-anchor='middle' fill='%23eceef1' font-family='Segoe UI, sans-serif' font-size='36' font-weight='700'%3EVantyr demo stream%3C/text%3E%3Ctext x='640' y='395' text-anchor='middle' fill='%23a4a8b2' font-family='Consolas, monospace' font-size='22'%3E${label}%3C/text%3E%3C/svg%3E`;
}

const alwaysVerified = () => true;
const unstamped = () => ({ ok: true, stamp: null });

/**
 * Demo mode has no MJPEG backend: show a believable fake desktop instead of a perpetual
 * "Connecting…" placeholder. A placeholder image (the demo stream URL) still drives load state
 * and pointer mapping, invisible over the mock desktop. There is no capture geometry, so input
 * is never stamped and the display always counts as verified.
 */
function useDemoFrameSource({ agentId, streamUrl: requestedUrl, session, streamEnabled, online, report }: FrameSourceOptions): FrameSource {
  const imgRef = useRef<HTMLImageElement>(null);
  // The session in the fragment gives every reconnect a fresh src, like the real stream's URL.
  const streamUrl = requestedUrl ? `${demoStreamUrl(agentId)}#${session}` : "";

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
