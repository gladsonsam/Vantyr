import Dither from "@/components/react-bits/Dither";

/**
 * One full-viewport dither behind the whole page, so the page keeps its atmosphere as it
 * scrolls. It drifts on its own and ignores the cursor. A dark veil keeps text legible.
 */
export function Backdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 bg-background" aria-hidden>
      <div className="absolute inset-0">
        <Dither
          waveColor="#20dd8f"
          backgroundColor="#141414"
          ditherMode="bayer"
          pixelSize={3}
          enableMouseInteraction={false}
          clickRipple={false}
          trail={0}
          dpr={1}
        />
      </div>
      <div className="absolute inset-0 bg-background/45" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,var(--background)_100%)] opacity-70" />
    </div>
  );
}
