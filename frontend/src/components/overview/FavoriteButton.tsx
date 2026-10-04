import { Star } from "lucide-react";
export function FavoriteButton({ name, favorite, disabled, onToggle }: { name: string; favorite: boolean; disabled?: boolean; onToggle: () => void }) {
  return <button type="button" aria-label={`Favorite ${name}`} aria-pressed={favorite} title={favorite ? "Remove from favorites" : "Add to favorites"} disabled={disabled}
    onClick={(event) => { event.stopPropagation(); onToggle(); }}
    style={{ width: 44, height: 44, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 8, border: 0, background: "transparent", color: favorite ? "var(--amber)" : "var(--tx-3)", cursor: disabled ? "not-allowed" : "pointer" }}>
    <Star size={18} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
  </button>;
}
