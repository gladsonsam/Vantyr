import { Link } from "react-router-dom";
import { Button } from "@vantyr/ui/components/button";
import { Card, CardContent } from "@vantyr/ui/components/card";
import { ConnectionStatus } from "@/features/devices/components/ConnectionStatus";
import { useDevice } from "@/features/devices/deviceContext";
import { IDENTITY_NOTE } from "@/features/devices/lib/identity";
import { TimeAgo } from "@/features/network/components/TimeAgo";

/** The Vantyr agent on this device. The agent tools themselves are still the full agent page. */
export function DeviceAgentPage() {
  const device = useDevice();
  const agent = device.connections.agent;
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-wrap items-center justify-between gap-6 p-5">
        <div className="space-y-1">
          <div className="flex items-center gap-4">
            <h3 className="font-medium">Vantyr agent</h3>
            <ConnectionStatus state={agent.state} />
          </div>
          <p className="text-sm text-muted-foreground">{IDENTITY_NOTE.agent}</p>
          <p className="text-sm text-muted-foreground">
            Last seen <TimeAgo iso={agent.lastSeenAt} />
          </p>
        </div>
        {device.agentId ? (
          <Button nativeButton={false} render={<Link to={`/agents/${device.agentId}`} />}>
            Open agent tools
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
