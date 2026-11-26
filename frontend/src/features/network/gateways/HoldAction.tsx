import type { ReactNode } from "react";
import HoldButton from "@/components/react-bits/HoldButton";

/** A destructive or hard-to-undo action that needs a deliberate hold, flat (no glow). */
export function HoldAction({
  children,
  doneLabel,
  icon,
  ariaLabel,
  disabled,
  destructive = true,
  onHold,
}: {
  children: ReactNode;
  doneLabel: string;
  icon?: ReactNode;
  ariaLabel: string;
  disabled?: boolean;
  destructive?: boolean;
  onHold: () => void;
}) {
  return (
    <HoldButton
      size="sm"
      icon={icon}
      holdTime={900}
      glow={false}
      ariaLabel={ariaLabel}
      doneLabel={doneLabel}
      backgroundColor="var(--muted)"
      textColor="var(--foreground)"
      fillColor={destructive ? "var(--destructive)" : "var(--primary)"}
      fillTextColor="var(--foreground)"
      disabled={disabled}
      onHold={onHold}
    >
      {children}
    </HoldButton>
  );
}
