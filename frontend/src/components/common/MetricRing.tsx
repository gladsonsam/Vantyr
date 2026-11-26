import type { ReactNode } from "react";
import { cn } from "@vantyr/ui/lib/utils";

export type MetricRingVariant = "cpu" | "memory" | "disk";
export type MetricRingTone = "default" | "warning" | "destructive";

const variantClass: Record<MetricRingVariant, string> = {
  cpu: "text-metric-cpu",
  memory: "text-metric-memory",
  disk: "text-metric-disk",
};

const toneClass = {
  warning: "text-warning",
  destructive: "text-destructive",
} as const;

function metricColorClass(variant: MetricRingVariant, tone: MetricRingTone = "default") {
  return tone === "default" ? variantClass[variant] : toneClass[tone];
}

type MetricRingProps = {
  percent?: number;
  variant: MetricRingVariant;
  tone?: MetricRingTone;
  size?: number;
  stroke?: number;
  children?: ReactNode;
  className?: string;
};

export function MetricRing({
  percent,
  variant,
  tone = "default",
  size = 26,
  stroke = 3.5,
  children,
  className,
}: MetricRingProps) {
  const clamped = percent === undefined || Number.isNaN(percent) ? 0 : Math.max(0, Math.min(100, percent));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-border"
        />
        {clamped > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap={clamped >= 3 ? "round" : "butt"}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className={cn("transition-[stroke-dashoffset] duration-300 ease-out", metricColorClass(variant, tone))}
          />
        )}
      </svg>
      {children ? <span className="relative flex items-center leading-none">{children}</span> : null}
    </span>
  );
}
