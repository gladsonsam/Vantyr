interface DotProps {
  color: string;
  size?: number;
  halo?: boolean;
}

export function Dot({ color, size = 8, halo = false }: DotProps) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        boxShadow: halo ? `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)` : "none",
      }}
    />
  );
}
