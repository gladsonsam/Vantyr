import type { IdentityEvidence } from "@/features/network/runtime/types";

export const EVIDENCE: Record<IdentityEvidence, { label: string; dot: string; text: string }> = {
  verified: { label: "Verified sign-in", dot: "bg-success", text: "text-success" },
  asserted: { label: "Asserted", dot: "bg-info", text: "text-info" },
  weak: { label: "Weak", dot: "bg-warning", text: "text-warning" },
  unknown: { label: "Unknown", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
};

export function evidenceLabel(evidence: IdentityEvidence): string {
  return EVIDENCE[evidence].label;
}

