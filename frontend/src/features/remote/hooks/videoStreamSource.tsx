import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { notifyMjpegViewerLeft } from '@/api';
import { controlGeometryAvailable } from '../lib/remoteFrame';
import { startVideoStream } from '../lib/videoStream';
import type { FrameSource, FrameSourceOptions, ScreenStreamSource } from '../lib/screenStreamSource';
import type { DisplayedRemoteFrame } from './useMjpegFrames';
import { useMjpegFrameSource } from './mjpegStreamSource';

function useVideoFrames(options: FrameSourceOptions): FrameSource {
  const canvas = useRef<HTMLCanvasElement>(null);
  const displayed = useRef<DisplayedRemoteFrame | null>(null);
  const displayedElement = useRef<HTMLCanvasElement | null>(null);
  const callbacks = useRef(options);
  useLayoutEffect(() => { callbacks.current = options; });
  const scope = options.enabled ? options.streamUrl.replace('/mjpeg?', '/video?') : '';
  const [state, setState] = useState<{ scope: string; frame: DisplayedRemoteFrame | null; error: string }>({ scope: '', frame: null, error: '' });
  // Layout changes can replace the canvas without changing the network scope.
  // A stamp is valid only for pixels actually committed to this exact element.
  const attachCanvas = useCallback((element: HTMLCanvasElement | null) => {
    if (canvas.current === element) return;
    const previous = canvas.current;
    canvas.current = element;
    displayed.current = null; displayedElement.current = null;
    callbacks.current.onBeforeDisplay(null);
    if (previous) { previous.width = 1; previous.height = 1; }
    if (element) {
      element.width = 1; element.height = 1; element.style.display = 'none';
      setState(previousState => previousState.frame ? { ...previousState, frame: null } : previousState);
      callbacks.current.report({ streaming: false, error: false });
    }
  }, []);
  const active = useRef<(() => void) | null>(null);
  const stop = useCallback(() => active.current?.(), []);
  useLayoutEffect(() => {
    const initialElement = canvas.current;
    const initial = callbacks.current;
    const clear = () => {
      displayed.current = null; displayedElement.current = null;
      initial.onBeforeDisplay(null);
      for (const element of new Set([initialElement, canvas.current])) {
        if (element) { element.width = 1; element.height = 1; element.style.display = 'none'; }
      }
    };
    clear();
    if (!scope) return;
    const transport = startVideoStream(scope, {
      present: (frame, packet) => {
        const element = canvas.current;
        if (!element) return;
        const g = packet.geometry;
        if (frame.displayWidth !== ((g.frame_width + 1) & ~1) || frame.displayHeight !== ((g.frame_height + 1) & ~1)) throw new Error('Video dimensions do not match the captured display.');
        const context = element.getContext('2d', { alpha: false });
        if (!context) throw new Error('Screen drawing is unavailable in this browser.');
        const committed = { width: g.frame_width, height: g.frame_height, geometry: g };
        callbacks.current.onBeforeDisplay(committed);
        element.width = committed.width; element.height = committed.height;
        context.drawImage(frame, 0, 0, g.frame_width, g.frame_height, 0, 0, g.frame_width, g.frame_height); element.style.display = 'block';
        displayed.current = committed; displayedElement.current = element;
        setState({ scope, frame: committed, error: '' });
        callbacks.current.report({ streaming: true, error: false, size: committed });
      },
      stopped: error => {
        clear();
        notifyMjpegViewerLeft(initial.agentId, initial.session);
        setState({ scope, frame: null, error });
        callbacks.current.report({ streaming: false, error: Boolean(error) });
      },
    });
    active.current = transport.cancel;
    const visibilityChanged = () => { if (document.hidden) transport.cancel(); };
    document.addEventListener('visibilitychange', visibilityChanged);
    if (document.hidden) transport.cancel();
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      transport.cancel();
      if (active.current === transport.cancel) active.current = null;
    };
  }, [scope]);
  const frame = state.scope === scope ? state.frame : null;
  const getDisplayed = useCallback(() => displayedElement.current === canvas.current ? displayed.current : null, []);
  const leaseStamp = useCallback(() => {
    const g = getDisplayed()?.geometry;
    return controlGeometryAvailable(g) ? { capture_id: g.capture_id, geometry_revision: g.geometry_revision } : null;
  }, [getDisplayed]);
  const surface = useCallback(() => {
    const e = canvas.current, f = getDisplayed();
    return e && f ? { getBoundingClientRect: () => e.getBoundingClientRect(), naturalWidth: f.width, naturalHeight: f.height } : null;
  }, [getDisplayed]);
  const verifiedNow = useCallback(() => controlGeometryAvailable(getDisplayed()?.geometry), [getDisplayed]);
  const inputStamp = useCallback(() => { const stamp = leaseStamp(); return { ok: stamp !== null, stamp }; }, [leaseStamp]);
  const failureReason = state.scope === scope ? state.error : '';
  return {
    surface,
    verified: controlGeometryAvailable(frame?.geometry),
    verifiedNow,
    leaseStamp,
    inputStamp,
    failed: Boolean(failureReason), failureReason: failureReason || undefined,
    connecting: !frame, detectsStalls: true, selfLive: false, stop,
    render: ({ layout, streamEnabled, visible, transform }) => <canvas ref={attachCanvas} role="img" aria-label="Agent screen" className={layout === 'card' ? 'vantyr-screen-image' : undefined} style={{ transform, ...(layout === 'embedded' ? { position: 'absolute', inset: 0 } as const : {}), width: '100%', height: '100%', objectFit: 'contain', display: streamEnabled && visible ? 'block' : 'none' }} />,
  };
}

/** Stable hook order; older agents and browsers retain the existing JPEG path. */
function useAdaptiveFrames(options: FrameSourceOptions): FrameSource {
  const video = options.videoEnabled === true && typeof VideoDecoder !== 'undefined';
  const jpegFrames = useMjpegFrameSource({ ...options, enabled: options.enabled && !video });
  const videoFrames = useVideoFrames({ ...options, enabled: options.enabled && video });
  return video ? videoFrames : jpegFrames;
}
export const adaptiveScreenStreamSource: ScreenStreamSource = { useFrames: useAdaptiveFrames, audio: true };
