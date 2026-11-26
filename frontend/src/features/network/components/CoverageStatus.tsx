import { cn } from "@/lib/utils";
import type { Coverage, Verification } from "@/features/network/runtime/types";

const COVERAGE_TONE: Record<Coverage, { text: string; label: string }> = {
  enforced: { text: "text-success", label: "Enforced" },
  offline: { text: "text-warning", label: "Offline" },
  unsupported: { text: "text-muted-foreground", label: "Not supported" },
  unknown: { text: "text-muted-foreground", label: "Unknown" },
  bypassed: { text: "text-warning", label: "Bypassed by policy" },
};

const VERIFICATION_TONE: Record<Verification, { text: string; label: string }> = {
  verified: { text: "text-success", label: "Verified" },
  unverified: { text: "text-muted-foreground", label: "Not verified" },
  failed: { text: "text-destructive", label: "Verification failed" },
};

function Status({ text, label, className }: { text: string; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", text, className)}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

/** What a gateway honestly claims for a capability, as icon-and-text in its hue (no pill). */
export function CoverageStatus({
  coverage,
  className,
}: {
  coverage: Coverage;
  className?: string;
}) {
  return <Status {...COVERAGE_TONE[coverage]} className={className} />;
}

/** Whether the applied policy was confirmed by a gateway check, as opposed to merely acknowledged. */
export function VerificationStatus({
  verification,
  className,
}: {
  verification: Verification;
  className?: string;
}) {
  return <Status {...VERIFICATION_TONE[verification]} className={className} />;
}

/** Plain online/offline word for a gateway or connection. */
export function OnlineStatus({ online, className }: { online: boolean; className?: string }) {
  return (
    <Status
      text={online ? "text-success" : "text-muted-foreground"}
      label={online ? "Online" : "Offline"}
      className={className}
    />
  );
}
