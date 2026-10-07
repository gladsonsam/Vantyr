import { Alert, AlertDescription, AlertTitle } from "@vantyr/ui/components/alert";
import type { AgentInfo } from "@/api/types";
import { capabilityLabel, capabilityStatus, type CapabilityKey } from "@/features/agent-detail/lib/agentCapabilities";

interface CapabilityNoticeProps {
  info?: AgentInfo | null;
  capability: CapabilityKey;
  title?: string;
}

export function CapabilityNotice({ info, capability, title }: CapabilityNoticeProps) {
  const status = capabilityStatus(info, capability) ?? "unsupported";
  return (
    <Alert>
      <AlertTitle>{title ?? `${capabilityLabel(capability)} unavailable`}</AlertTitle>
      <AlertDescription>
        This agent reports <strong>{capabilityLabel(capability)}</strong> as <code>{status}</code>.
        Resource history, specs, logs, and other supported telemetry remain available.
      </AlertDescription>
    </Alert>
  );
}
