import { useEffect, useState } from "react";

function mediaQueryList(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query)
    : null;
}

/** Client-side breakpoint helper for responsive layouts (SPA). Reports `false` where `matchMedia` is missing. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaQueryList(query)?.matches ?? false);

  useEffect(() => {
    const mq = mediaQueryList(query);
    if (!mq) return;
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
