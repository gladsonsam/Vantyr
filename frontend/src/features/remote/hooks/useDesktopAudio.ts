import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/api";

/**
 * Plays the agent's desktop audio: a fetch stream with a 6-byte header (sample rate u32,
 * channel count u16, little-endian) followed by interleaved little-endian Float32 PCM,
 * scheduled gaplessly on a Web Audio context. Stops when the agent goes offline or on unmount.
 */
export function useDesktopAudio({ agentId, online, enabled }: { agentId: string; online: boolean; enabled: boolean }) {
  const [audioActive, setAudioActive] = useState(false);
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
  }, []);

  const startAudio = useCallback(async () => {
    stopAudio();
    if (!enabled || !online) return;

    const abort = new AbortController();
    audioAbortRef.current = abort;
    setAudioActive(true);

    try {
      const resp = await fetch(apiUrl(`/agents/${agentId}/audio`), {
        credentials: "include",
        signal: abort.signal,
      });
      if (!resp.ok || !resp.body) { stopAudio(); return; }

      const reader = resp.body.getReader();
      let metaBuf = new Uint8Array(0);
      let metaReady = false;
      let sampleRate = 48000;
      let channels = 2;
      let ctx: AudioContext | null = null;
      let remainder = new Uint8Array(0);

      while (true) {
        const { done, value } = await reader.read();
        if (done || abort.signal.aborted) break;
        if (!value || value.length === 0) continue;

        if (!metaReady) {
          const joined = new Uint8Array(metaBuf.length + value.length);
          joined.set(metaBuf); joined.set(value, metaBuf.length);
          metaBuf = joined;
          if (metaBuf.length < 6) continue;
          const view = new DataView(metaBuf.buffer);
          sampleRate = view.getUint32(0, true);
          channels = view.getUint16(4, true);
          metaReady = true;
          ctx = new AudioContext({ sampleRate });
          audioCtxRef.current = ctx;
          remainder = metaBuf.slice(6);
        } else {
          const joined = new Uint8Array(remainder.length + value.length);
          joined.set(remainder); joined.set(value, remainder.length);
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
        const startAt = Math.max(nextPlayTimeRef.current, now + 0.05);
        node.start(startAt);
        nextPlayTimeRef.current = startAt + audioBuf.duration;
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.warn("Audio stream error:", e);
      }
    }
    stopAudio();
  }, [agentId, online, stopAudio, enabled]);

  // The flag derives during render; the effect below only tears down the
  // browser audio objects.
  const [wasOnline, setWasOnline] = useState(online);
  if (wasOnline !== online) {
    setWasOnline(online);
    if (!online) setAudioActive(false);
  }

  // Stop audio when agent goes offline or component unmounts.
  useEffect(() => {
    if (!online) {
      audioAbortRef.current?.abort();
      audioAbortRef.current = null;
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      nextPlayTimeRef.current = 0;
    }
  }, [online]);
  useEffect(() => () => stopAudio(), [stopAudio]);

  return { active: audioActive, start: startAudio, stop: stopAudio };
}
