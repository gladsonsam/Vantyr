import { HelpTip } from "@/components/common/HelpTip";
import type { IdentityEvidence } from "@/features/network/runtime/types";
import { cn } from "@/lib/utils";
import { EVIDENCE } from "./evidenceLib";

/** How well the person on an event is known: a small dot and text, never a chip. */
export function EvidenceLabel({ evidence }: { evidence: IdentityEvidence }) {
  const entry = EVIDENCE[evidence];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", entry.text)}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", entry.dot)} />
      {entry.label}
    </span>
  );
}

/** One explanation of what a person label means, for the heading of any list that shows them. */
export function EvidenceHelp() {
  return (
    <HelpTip label="About person labels">
      A person label is evidence-based: it shows who the gateway had good reason to believe was
      using the device, and how it knows. DNS-only events identify a device, not a person.
    </HelpTip>
  );
}
