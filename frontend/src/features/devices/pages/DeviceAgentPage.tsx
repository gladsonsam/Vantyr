import { Link } from "react-router-dom";
import { Button } from "@vantyr/ui/components/button";
import { DetailSection } from "@/components/common/resource-detail/DetailSection";
import { ConnectionFacts } from "@/features/devices/components/ConnectionFacts";
import { useDevice } from "@/features/devices/deviceContext";

/** The Vantyr agent on this device. The agent tools themselves are still the full agent page. */
export function DeviceAgentPage() {
  const device = useDevice();
  const agent = device.connections.agent;
  return (
    <div className="space-y-8">
      <ConnectionFacts title="Vantyr agent" connection={agent} seenLabel="Last seen" />
      {device.agentId ? (
        <DetailSection title="Agent tools">
          <Button nativeButton={false} render={<Link to={`/agents/${device.agentId}`} />}>
            Open agent tools
          </Button>
        </DetailSection>
      ) : null}
    </div>
  );
}
