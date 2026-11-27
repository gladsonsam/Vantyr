import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";
import { errorText } from "@/api";
import {
  networkQueries,
  useSetDesiredPolicyMutation,
  type GatewayObservation,
} from "@/api/queries/network";
import type { NetworkDesiredPolicy, NetworkGateway } from "@/api/types";
import { Button } from "@vantyr/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vantyr/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { Spinner } from "@vantyr/ui/components/spinner";
import { SettingsRow, SettingsSection } from "@/features/settings/components/SettingsLayout";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { desiredVsReported, revisionLabel } from "./gatewayStatusLib";
import { DesiredStatusMark } from "./gatewayStatus";

/**
 * Desired policy for a gateway. Assigning only records the request; what the gateway then reports
 * is shown beside it as “reported applied”, never as verified.
 */
export function GatewayDesiredSection({
  household,
  gateway,
  desired,
  observation,
  isAdmin,
}: {
  household: string;
  gateway: NetworkGateway;
  desired: NetworkDesiredPolicy | null;
  observation: GatewayObservation | null;
  isAdmin: boolean;
}) {
  const policies = useQuery(networkQueries.policies(household, { limit: 50 }));
  const assign = useSetDesiredPolicyMutation(household);
  const [choice, setChoice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revisions = policies.data?.policies ?? [];
  const state = desiredVsReported(desired, observation);
  const canAssign = isAdmin && !gateway.revoked_at;

  const confirm = async () => {
    if (choice === null) return;
    setError(null);
    try {
      await assign.mutateAsync({ gateway: gateway.id, revision: Number(choice) });
      setConfirming(false);
      setChoice(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <SettingsSection
      title="Desired policy"
      icon={<Target />}
      help="Desired is the saved revision you ask this gateway to run. Reported applied is the gateway’s own claim. A report is not verification."
    >
      <div className="space-y-3 px-5 py-4">
        <DesiredStatusMark state={state} />
        {desired ? (
          <p className="text-[0.8125rem] text-muted-foreground">
            Assigned {revisionLabel(desired.revision)} <TimeAgo iso={desired.assigned_at} />
          </p>
        ) : null}
      </div>
      {canAssign ? (
        <SettingsRow
          label="Assign a revision"
          description="Pick a saved revision. Nothing runs until the gateway fetches and reports it."
          controlClassName="gap-2"
        >
          <div className="flex w-full items-center gap-2">
            <Select
              value={choice}
              onValueChange={(v) => setChoice(v as string | null)}
              disabled={revisions.length === 0}
            >
              <SelectTrigger className="w-full" aria-label="Revision to assign">
                <SelectValue
                  placeholder={revisions.length ? "Choose revision" : "No saved revisions"}
                />
              </SelectTrigger>
              <SelectContent>
                {revisions.map((policy) => (
                  <SelectItem key={policy.revision} value={String(policy.revision)}>
                    {revisionLabel(policy.revision)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              disabled={choice === null || Number(choice) === desired?.revision}
              onClick={() => setConfirming(true)}
            >
              Assign
            </Button>
          </div>
        </SettingsRow>
      ) : null}
      <Dialog open={confirming} onOpenChange={(next) => !assign.isPending && setConfirming(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Assign {choice === null ? "" : revisionLabel(Number(choice))} to {gateway.label}?
            </DialogTitle>
            <DialogDescription>
              This sets the desired revision. The gateway reports what it applied; Vantyr doesn’t
              verify it.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={assign.isPending}
            >
              Cancel
            </Button>
            <Button onClick={() => void confirm()} disabled={assign.isPending}>
              {assign.isPending ? <Spinner /> : null}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
