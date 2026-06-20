import type { CSSProperties } from "react";
import * as LucideIcons from "lucide-react";
import { User } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { isUserPhotoDataUrl, parseUserLucideIcon } from "../../lib/userAvatar";


const hashHue = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
};

export interface DashboardUserAvatarProps {
  username: string;
  /** Used for initials / title when no photo or Lucide icon (e.g. full name). */
  displayName?: string | null;
  displayIcon?: string | null;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** Circle avatar: optional Lucide icon key, photo data URL, or colored initials. */
export function DashboardUserAvatar({
  username,
  displayName,
  displayIcon,
  size = 36,
  className,
  style,
}: DashboardUserAvatarProps) {
  const raw = displayIcon?.trim() ?? "";
  const label = displayName?.trim() || username;
  const hue = hashHue(username || "user");
  const bg = `hsl(${hue} 42% 36%)`;
  const fg = "hsl(0 0% 98%)";

  if (isUserPhotoDataUrl(raw)) {
    return (
      <img
        className={`vantyr-user-avatar vantyr-user-avatar--photo ${className ?? ""}`}
        src={raw}
        alt=""
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          objectFit: "cover",
          borderRadius: "50%",
          flexShrink: 0,
          ...style,
        }}
        title={label}
      />
    );
  }

  const lucideName = parseUserLucideIcon(raw);
  if (lucideName) {
    const Cmp = (LucideIcons as unknown as Record<string, LucideIcon>)[lucideName];
    if (Cmp) {
      return (
        <span
          className={`vantyr-user-avatar vantyr-user-avatar--lucide ${className ?? ""}`}
          style={{
            width: size,
            height: size,
            background: bg,
            color: fg,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "50%",
            flexShrink: 0,
            ...style,
          }}
          title={label}
          aria-hidden
        >
          <Cmp size={Math.max(14, size * 0.52)} strokeWidth={2} color={fg} />
        </span>
      );
    }
  }

  return (
    <span
      className={`vantyr-user-avatar vantyr-user-avatar--icon ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        flexShrink: 0,
        background: bg,
        color: fg,
        ...style,
      }}
      title={label}
      aria-label={`${label} avatar`}
    >
      <User size={Math.max(12, Math.round(size * 0.52))} strokeWidth={2} color={fg} />
    </span>
  );
}
