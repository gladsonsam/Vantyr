import { useCallback, useEffect, useRef, useState } from "react";

const SOUND_KEY = "vantyr.remote.sound";
const FULLSCREEN_CONTROL_KEY = "vantyr.remote.fullscreenControl";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "on";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    window.localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
}

/** Persisted boolean; `fallback` applies until the user chooses. */
function usePersistedFlag(key: string, fallback: boolean) {
  const [on, setOn] = useState(() => readFlag(key, fallback));
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
      writeFlag(key, next);
    },
    [key],
  );
  return [on, set] as const;
}

/** Fullscreen also takes control (default on), unless the user turned that off. */
export function useFullscreenControlPreference() {
  return usePersistedFlag(FULLSCREEN_CONTROL_KEY, true);
}

/**
 * Desktop sound is on by default and remembers the last choice. The automatic start needs a
 * user gesture (browser autoplay rules): it runs at once when the page has already had one,
 * otherwise on the next click, key or touch, and stays quietly off if the browser refuses.
 */
export function useSoundPreference(
  audio: {
    active: boolean;
    connecting: boolean;
    start: (options?: { silent?: boolean }) => Promise<void>;
  },
  ready: boolean,
) {
  const [wanted, setWanted] = usePersistedFlag(SOUND_KEY, true);
  const triedNow = useRef(false);
  const { active, connecting, start } = audio;
  useEffect(() => {
    if (!ready) {
      triedNow.current = false;
      return;
    }
    if (!wanted || active || connecting) return;
    const events = ["pointerdown", "keydown", "touchend"] as const;
    const remove = () => events.forEach((e) => document.removeEventListener(e, attempt, true));
    function attempt() {
      remove();
      void start({ silent: true });
    }
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } })
      .userActivation;
    if (activation?.hasBeenActive && !triedNow.current) {
      triedNow.current = true;
      attempt();
      return;
    }
    events.forEach((e) => document.addEventListener(e, attempt, true));
    return remove;
  }, [ready, wanted, active, connecting, start]);
  /** Wanted but not playing yet: the sound button offers "Click to enable sound". */
  const awaitingGesture = ready && wanted && !active && !connecting;
  return { setWanted, awaitingGesture };
}
