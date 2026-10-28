import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@vantyr/ui/components/popover";
import { cn } from "@/lib/utils";

/**
 * A small (?) next to a title or label that holds the explanation, so screens show labels and
 * values instead of paragraphs. Opens on hover on desktop and on tap on touch screens.
 */
export function HelpTip({ children, label = "More info", className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        render={
          <button
            type="button"
            aria-label={label}
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              className,
            )}
          />
        }
      >
        <CircleHelp className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent side="top" className="w-72 text-xs leading-relaxed font-normal text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}
