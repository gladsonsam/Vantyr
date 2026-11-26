import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import CallChip from "@/components/react-bits/CallChip";
import { useRunCheckMutation } from "@/features/network/runtime/useRuntimeQueries";
import type { ConnectionCheck } from "@/features/network/runtime/types";
import { HelpTip } from "@/components/common/HelpTip";
import { cn } from "@/lib/utils";

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
 * ended; it says what the gateway answered, not that the device is "protected". `compact` is a small icon
 * button with the outcome as one line of text underneath.
 */
export function RunCheck({
  deviceId,
  kind,
  deviceLabel,
  compact = false,
}: {
  deviceId: string;
  kind: "dns" | "proxy";
  deviceLabel: string;
  compact?: boolean;
}) {
  const check = useRunCheckMutation();
  const result = check.data?.state === "ready" ? check.data.data : null;
  const state = status(check.status, result);
  const run = () => check.mutate({ deviceId, kind });
  if (compact) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Run check"
          title={`${NAME[kind]}. One check cannot prove gateway reachability, the DNS decision, proxy sign-in, certificate trust and coverage.`}
          disabled={state === "running"}
          onClick={run}
        >
          {state === "running" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RotateCw className={cn("size-4", state === "error" && "text-destructive")} />
          )}
        </Button>
        {result ? (
          <p
            className={cn(
              "max-w-40 text-right text-xs",
              result.ok ? "text-success" : "text-destructive",
            )}
          >
            {result.detail}
            {result.ok ? ` ${result.ms} ms.` : ""}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {state === "idle" ? (
        <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={run}>
          Run check
        </Button>
        <HelpTip label="About running a check">
          Gateway reachability, the DNS decision, proxy sign-in, certificate trust and canary
          coverage are different checks. One generic result can’t prove all of them, so read it as
          only what the gateway answered.
        </HelpTip>
        </div>
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
