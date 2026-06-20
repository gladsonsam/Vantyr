import { Alert } from "../ui/console";
import type { AgentInfo } from "../../lib/types";
import { capabilityLabel, capabilityStatus, type CapabilityKey } from "../../lib/agentCapabilities";

interface CapabilityNoticeProps {
  info?: AgentInfo | null;
  capability: CapabilityKey;
  title?: string;
}

export function CapabilityNotice({ info, capability, title }: CapabilityNoticeProps) {
  const status = capabilityStatus(info, capability) ?? "unsupported";
  return (
    <Alert type="info" header={title ?? `${capabilityLabel(capability)} unavailable`}>
      This agent reports <strong>{capabilityLabel(capability)}</strong> as <code>{status}</code>.
      Resource history, specs, logs, and other supported telemetry remain available.
    </Alert>
  );
}
