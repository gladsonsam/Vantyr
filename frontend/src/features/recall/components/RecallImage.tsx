import { useState } from "react";
import type { CSSProperties } from "react";

/** Failed thumbnails remain identifiable without showing a broken-image glyph. */
export function RecallImage({ src, style, loading }: { src: string; style?: CSSProperties; loading?: "lazy" }) {
  const [failed, setFailed] = useState<string | null>(null);
  return failed === src ? (
    <span role="img" aria-label="Captured image unavailable" style={{ ...style, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 }}>Image unavailable</span>
  ) : <img key={src} src={src} alt="" loading={loading} style={style} onError={() => setFailed(src)} />;
}
