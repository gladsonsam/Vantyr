import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Card, CardContent } from "@vantyr/ui/components/card";
import type { Availability } from "@/features/network/runtime/types";

/** A section whose backing API does not exist yet. It says so plainly instead of showing a value. */
export function UnavailableSection({ title, reason }: { title: string; reason: string }) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex items-start gap-3 p-5 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <div className="font-medium">{title}</div>
          <p className="text-muted-foreground">{reason}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Renders `children` for ready data, or the unavailable notice. Never invents a fallback value. */
export function AvailabilityGate<T>({
  title,
  value,
  children,
}: {
  title: string;
  value: Availability<T>;
  children: (data: T) => ReactNode;
}) {
  if (value.state === "unavailable") {
    return <UnavailableSection title={title} reason={value.reason} />;
  }
  return <>{children(value.data)}</>;
}
