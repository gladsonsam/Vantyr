import { cn } from "@vantyr/ui/lib/utils";

export type SegmentToggleOption<T extends string = string> = {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
};

type SegmentToggleProps<T extends string = string> = {
  value: T;
  onChange: (value: T) => void;
  options: SegmentToggleOption<T>[];
  /** Accessible name of the group. */
  label: string;
  className?: string;
};

export function SegmentToggle<T extends string = string>({
  value,
  onChange,
  options,
  label,
  className,
}: SegmentToggleProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5 text-xs leading-5 whitespace-nowrap",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center justify-center rounded-sm px-2 py-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              active
                ? "bg-primary/15 font-medium text-primary"
                : "text-muted-foreground hover:text-primary",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
