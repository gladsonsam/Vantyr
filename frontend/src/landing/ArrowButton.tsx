import { ArrowDownRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Black label + arrow square on a lime plate that peeks out behind the arrow, so the two read as
 * one rounded control. The arrow turns up on hover.
 */
export function ArrowButton({
  href,
  children,
  radius = "rounded-xl",
  arrowClassName = "text-black",
}: {
  href: string;
  children: ReactNode;
  radius?: string;
  arrowClassName?: string;
}) {
  return (
    <a href={href} className="group relative inline-flex items-center">
      <span
        className={`absolute inset-y-0 right-0 w-[calc(100%-1.5rem)] bg-[var(--landing-accent)] ${radius}`}
      />
      <span
        className={`relative z-10 bg-foreground px-5 py-3 text-sm font-medium text-background ${radius}`}
      >
        {children}
      </span>
      <span
        className={`relative -left-px z-10 flex size-10 items-center justify-center ${radius} ${arrowClassName}`}
      >
        <ArrowDownRight className="size-4 transition-transform duration-300 group-hover:-rotate-45" />
      </span>
    </a>
  );
}
