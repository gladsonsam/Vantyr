import { Button } from "@vantyr/ui/components/button";
import CallChip from "@/components/react-bits/CallChip";
import { useRunCheckMutation } from "@/features/network/runtime/useRuntimeQueries";
import type { ConnectionCheck } from "@/features/network/runtime/types";

const NAME = { dns: "Check DNS", proxy: "Check proxy" } as const;

function status(
  state: ReturnType<typeof useRunCheckMutation>["status"],
  result: ConnectionCheck | null,
) {
  if (state === "pending") return "running" as const;
  if (state === "error" || (state === "success" && result && !result.ok)) return "error" as const;
  if (state === "success") return "done" as const;
  return "idle" as const;
}

/**
 * Asks the gateway whether it can see this device right now. The chip shows the check running and how it
 * ended; it says what the gateway answered, not that the device is "protected".
 */
export function RunCheck({
  deviceId,
  kind,
  deviceLabel,
}: {
  deviceId: string;
  kind: "dns" | "proxy";
  deviceLabel: string;
}) {
  const check = useRunCheckMutation();
  const result = check.data?.state === "ready" ? check.data.data : null;
  const state = status(check.status, result);
  const run = () => check.mutate({ deviceId, kind });
  return (
    <div className="space-y-2">
      {state === "idle" ? (
        <Button variant="outline" size="sm" onClick={run}>
          Run check
        </Button>
      ) : (
        <CallChip
          icon="search"
          name={NAME[kind]}
          argument={deviceLabel}
          status={state}
          expectedMs={1200}
          onRetry={run}
        />
      )}
      {result ? (
        <p className="text-sm text-muted-foreground">
          {result.detail}
          {result.ok ? ` ${result.ms} ms.` : ""}
        </p>
      ) : null}
    </div>
  );
}
