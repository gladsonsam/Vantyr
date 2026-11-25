import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { notifyMjpegViewerLeft } from '@/api';
import { controlGeometryAvailable } from '../lib/remoteFrame';
import { VideoPacketParser, type VideoPacket } from '../lib/videoFrame';
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
    let alive = true;
    const initialElement = canvas.current;
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let decoder: VideoDecoder | null = null;
    let configuration = '';
    let serial = 0;
    let connectTimeout: ReturnType<typeof setTimeout> | undefined;
    const pending = new Map<number, VideoPacket>();
    const initial = callbacks.current;
    const clear = () => {
      displayed.current = null; displayedElement.current = null;
      initial.onBeforeDisplay(null);
      for (const element of new Set([initialElement, canvas.current])) {
        if (element) { element.width = 1; element.height = 1; element.style.display = 'none'; }
      }
    };
    clear();
    const end = (error = '') => {
      if (!alive) return;
      alive = false; abort.abort();
      clearTimeout(connectTimeout);
      void reader?.cancel().catch(() => {});
      if (decoder && decoder.state !== 'closed') decoder.close();
      pending.clear(); clear();
      if (scope) {
        notifyMjpegViewerLeft(initial.agentId, initial.session);
        setState({ scope, frame: null, error });
        callbacks.current.report({ streaming: false, error: Boolean(error) });
      }
    };
    active.current = () => end();
    const visibilityChanged = () => { if (document.hidden) end(); };
    document.addEventListener('visibilitychange', visibilityChanged);
    if (scope && document.hidden) end();
    if (scope && alive) {
      connectTimeout = setTimeout(() => end('Live view did not connect. Reconnect to try again.'), 15_000);
      void (async () => {
      try {
        if (typeof VideoDecoder === 'undefined') throw new Error('Video decoding is unavailable in this browser.');
        decoder = new VideoDecoder({
          error: () => end('Video decoding failed. Reconnect to try again.'),
          output: frame => {
            try {
              const packet = pending.get(frame.timestamp); pending.delete(frame.timestamp);
              const element = canvas.current;
              if (!alive || !packet || !element) return;
              const g = packet.geometry;
              if (frame.displayWidth !== ((g.frame_width + 1) & ~1) || frame.displayHeight !== ((g.frame_height + 1) & ~1)) throw new Error('Video dimensions do not match the captured display.');
              const context = element.getContext('2d', { alpha: false });
              if (!context) throw new Error('Screen drawing is unavailable in this browser.');
              const committed = { width: g.frame_width, height: g.frame_height, geometry: g };
              callbacks.current.onBeforeDisplay(committed);
              element.width = committed.width; element.height = committed.height;
              context.drawImage(frame, 0, 0, g.frame_width, g.frame_height, 0, 0, g.frame_width, g.frame_height); element.style.display = 'block';
              displayed.current = committed; displayedElement.current = element;
              clearTimeout(connectTimeout);
              setState({ scope, frame: committed, error: '' });
              callbacks.current.report({ streaming: true, error: false, size: committed });
            } catch (error) { end(error instanceof Error ? error.message : 'Video display failed.'); }
            finally { frame.close(); }
          },
        });
        const response = await fetch(scope, { credentials: 'include', cache: 'no-store', signal: abort.signal });
        if (!alive) { void response.body?.cancel().catch(() => {}); return; }
        const fallback = response.status === 409
          ? 'Screen selection is locked or unavailable. Release control, then reconnect; another operator may still have control.'
          : `Screen stream request failed (${response.status}). Reconnect to try again.`;
        if (!response.body) throw new Error(fallback);
        reader = response.body.getReader();
        if (!response.ok) {
          const bytes = new Uint8Array(8192); let size = 0;
          while (alive) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (size + chunk.value.length > bytes.length) throw new Error(fallback);
            bytes.set(chunk.value, size); size += chunk.value.length;
          }
          if (!alive) return;
          let message = fallback;
          try {
            const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
            if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' && value.error.trim()) message = value.error.replace(/\s+/g, ' ').slice(0, 512);
          } catch { /* keep the actionable, bounded fallback */ }
          throw new Error(message);
        }
        const parser = new VideoPacketParser();
        const receive = (packet: VideoPacket) => {
          if (!alive || !decoder || decoder.state === 'closed') return;
          // All packets are IDR: dropping before decoding is safe and bounds latency.
          if (pending.size >= 3 || decoder.decodeQueueSize >= 2) return;
          if (configuration !== packet.codec) {
            if (pending.size) return;
            decoder.configure({ codec: packet.codec, optimizeForLatency: true });
            configuration = packet.codec;
          }
          const timestamp = ++serial;
          pending.set(timestamp, packet);
          decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp, data: packet.data.slice().buffer }));
        };
        while (alive) {
          const chunk = await reader.read();
          if (!alive) break;
          if (chunk.done) { parser.finish(); throw new Error('Screen stream ended. Reconnect to continue.'); }
          parser.push(chunk.value, receive);
        }
      } catch (error) { if (alive) end(error instanceof Error ? error.message : 'Video stream failed.'); }
      finally { try { reader?.releaseLock(); } catch { /* aborted read may still be settling */ } }
      })();
    }
    return () => { document.removeEventListener('visibilitychange', visibilityChanged); end(); if (active.current) active.current = null; };
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
