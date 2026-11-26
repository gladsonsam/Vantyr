import type { CSSProperties } from "react";

const BAR = "pointer-events-none fixed z-[9999] bg-[var(--landing-frame)] max-[850px]:hidden";
const CORNER = "pointer-events-none fixed z-[9998] text-[var(--landing-frame)] max-[850px]:hidden";

/** Concave fillet: fills the square corner that a rounded viewport corner leaves behind. */
function Corner({ className, style }: { className: string; style: CSSProperties }) {
  return (
    <svg
      className={`${CORNER} ${className}`}
      style={style}
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      aria-hidden
    >
      <path d="M0 0C0 37.3 9 50 50 50H0V0Z" fill="currentColor" />
    </svg>
  );
}

/**
 * A white picture frame around the viewport (10px bars, rounded inner corners). Desktop only;
 * the top bar hangs from it and joins it with matching concave flares.
 */
export function Frame() {
  return (
    <>
      <div className={`${BAR} inset-x-0 top-0 h-2.5`} />
      <div className={`${BAR} inset-x-0 bottom-0 h-2.5`} />
      <div className={`${BAR} inset-y-0 left-0 w-2.5`} />
      <div className={`${BAR} inset-y-0 right-0 w-2.5`} />
      <Corner className="top-2.5 left-2.5" style={{ transform: "rotate(90deg)" }} />
      <Corner className="top-2.5 right-2.5" style={{ transform: "rotate(180deg)" }} />
      <Corner className="bottom-2.5 left-2.5" style={{}} />
      <Corner className="right-2.5 bottom-2.5" style={{ transform: "rotate(-90deg)" }} />
    </>
  );
}
