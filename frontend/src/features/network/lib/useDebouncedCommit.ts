import { useCallback, useEffect, useRef } from "react";

/** Runs `commit` once the value has stopped changing, so dragging a slider saves once, not per pixel. */
export function useDebouncedCommit<T>(commit: (value: T) => void, delayMs = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(commit);
  useEffect(() => {
    latest.current = commit;
  }, [commit]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(
    (value: T) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => latest.current(value), delayMs);
    },
    [delayMs],
  );
}
