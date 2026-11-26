import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import type { Availability } from "@/features/network/runtime/types";

/** A section whose backing API does not exist yet. It says so plainly instead of showing a value. */
export function UnavailableSection({ title, reason }: { title: string; reason: string }) {
  return (
    <SettingsSection title={title} icon={<Info />} bodyClassName="px-5 py-4">
      <p className="text-sm text-muted-foreground">{reason}</p>
    </SettingsSection>
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
