import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/api";

/**
 * Plays the agent's desktop audio: a fetch stream with a 6-byte header (sample rate u32,
 * channel count u16, little-endian) followed by interleaved little-endian Float32 PCM,
 * scheduled gaplessly on a Web Audio context. Stops when the agent goes offline or on unmount.
 */
export function useDesktopAudio({
  agentId,
  online,
  enabled,
}: {
  agentId: string;
  online: boolean;
  enabled: boolean;
}) {
  const [audioActive, setAudioActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioAbortRef = useRef<AbortController | null>(null);
  const nextPlayTimeRef = useRef<number>(0);

  const stopAudio = useCallback(() => {
    audioAbortRef.current?.abort();
    audioAbortRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    nextPlayTimeRef.current = 0;
    setAudioActive(false);
    setConnecting(false);
  }, []);

  const startAudio = useCallback(async () => {
    stopAudio();
    if (!enabled || !online) return;

    const abort = new AbortController();
    audioAbortRef.current = abort;
    setError("");
    setConnecting(true);
    const connectionTimeout = window.setTimeout(() => {
      if (audioAbortRef.current !== abort) return;
      setError("Desktop audio didn’t connect. Check device audio permission and try again.");
      stopAudio();
    }, 15_000);

    try {
      // Create/resume during the initiating click, before network awaits consume
      // browser user activation. A running context can resample incoming PCM.
      const playback = new AudioContext();
      audioCtxRef.current = playback;
      await playback.resume();
      if (abort.signal.aborted || audioAbortRef.current !== abort) return;
      if (playback.state !== "running") throw new Error("playback blocked");
      const resp = await fetch(apiUrl(`/agents/${agentId}/audio`), {
        credentials: "include",
        signal: abort.signal,
      });
      if (abort.signal.aborted || audioAbortRef.current !== abort) return;
      if (!resp.ok || !resp.body) throw new Error("audio unavailable");

      const reader = resp.body.getReader();
      let metaBuf = new Uint8Array(0);
      let metaReady = false;
      let sampleRate = 48000;
      let channels = 2;
      let ctx: AudioContext | null = null;
      let remainder = new Uint8Array(0);

      while (true) {
        const { done, value } = await reader.read();
        if (audioAbortRef.current !== abort) return;
        if (done || abort.signal.aborted) break;
        if (!value || value.length === 0) continue;

        if (!metaReady) {
          const joined = new Uint8Array(metaBuf.length + value.length);
          joined.set(metaBuf);
          joined.set(value, metaBuf.length);
          metaBuf = joined;
          if (metaBuf.length < 6) continue;
          const view = new DataView(metaBuf.buffer);
          sampleRate = view.getUint32(0, true);
          channels = view.getUint16(4, true);
          if (sampleRate < 8000 || sampleRate > 192000 || channels < 1 || channels > 8)
            throw new Error("invalid audio format");
          metaReady = true;
          ctx = playback;
          window.clearTimeout(connectionTimeout);
          setConnecting(false);
          setAudioActive(true);
          remainder = metaBuf.slice(6);
        } else {
          const joined = new Uint8Array(remainder.length + value.length);
          joined.set(remainder);
          joined.set(value, remainder.length);
          remainder = joined;
        }

        if (!ctx) continue;

        // Decode all complete Float32 samples from the accumulated buffer.
        const floatCount = Math.floor(remainder.length / 4);
        if (floatCount < channels) continue;

        const alignedCount = Math.floor(floatCount / channels) * channels;
        const usedBytes = alignedCount * 4;
        const pcm = remainder.slice(0, usedBytes);
        remainder = remainder.slice(usedBytes);

        const frameCount = alignedCount / channels;
        const audioBuf = ctx.createBuffer(channels, frameCount, sampleRate);
        const dataView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        for (let ch = 0; ch < channels; ch++) {
          const channelData = audioBuf.getChannelData(ch);
          for (let i = 0; i < frameCount; i++) {
            channelData[i] = dataView.getFloat32((i * channels + ch) * 4, true);
          }
        }

        const node = ctx.createBufferSource();
        node.buffer = audioBuf;
        node.connect(ctx.destination);
        const now = ctx.currentTime;
        // Discard accumulated network backlog instead of playing seconds behind.
        if (nextPlayTimeRef.current > now + 0.5) continue;
        const startAt = Math.max(nextPlayTimeRef.current, now + 0.05);
        node.start(startAt);
        nextPlayTimeRef.current = startAt + audioBuf.duration;
      }
      if (!abort.signal.aborted && audioAbortRef.current === abort)
        setError("Desktop audio disconnected. Turn sound on to reconnect.");
    } catch {
      if (!abort.signal.aborted && audioAbortRef.current === abort)
        setError("Couldn’t play desktop audio. Check device audio permission and try again.");
    } finally {
      window.clearTimeout(connectionTimeout);
      // An old request must never stop a newer request started by another click.
      if (audioAbortRef.current === abort) stopAudio();
    }
  }, [agentId, online, stopAudio, enabled]);

  // Stop on device, capability, role or visibility changes as well as unmount.
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) stopAudio();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      stopAudio();
    };
  }, [agentId, online, enabled, stopAudio]);

  return {
    active: audioActive && online && enabled,
    connecting: connecting && online && enabled,
    error: enabled && online ? error : "",
    start: startAudio,
    stop: stopAudio,
  };
}
