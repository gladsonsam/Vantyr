import { useState } from "react";
import { Power } from "lucide-react";
import { errorText } from "@/api";
import { useUpdateGatewayMutation } from "@/api/queries/network";
import type { NetworkGateway } from "@/api/types";
import SquishSwitch from "@/components/react-bits/SquishSwitch";
import { ConfirmActionDialog } from "@/features/rules/components/ConfirmActionDialog";
import { FormDialog } from "@/features/network/household/FormDialog";
import { SettingsRow, SettingsSection } from "@/features/settings/components/SettingsLayout";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import { EnabledStatus } from "./gatewayStatus";

const SWITCH = {
  trackColor: "var(--muted)",
  trackOnColor: "var(--primary)",
  thumbColor: "var(--foreground)",
  thumbOnColor: "var(--primary-foreground)",
} as const;

const DISABLE_COPY =
  "The gateway stops being able to fetch policy or heartbeat. Credentials are not revoked.";

/** Rename a gateway from its detail page. Label edits stay allowed for a revoked gateway. */
export function RenameGatewayDialog({ household, gateway }: { household: string; gateway: NetworkGateway }) {
  const update = useUpdateGatewayMutation(household);
  const [label, setLabel] = useState(gateway.label);
  const changed = label.trim() !== gateway.label;
  return (
    <FormDialog
      edit
      trigger="Rename"
      title="Rename gateway"
      submitLabel="Save"
      canSubmit={label.trim().length > 0 && changed}
      onSubmit={() => update.mutateAsync({ id: gateway.id, label: label.trim() })}
      onReset={() => setLabel(gateway.label)}
    >
      <div className="space-y-2">
        <Label htmlFor={`gateway-label-${gateway.id}`}>Label</Label>
        <Input
          id={`gateway-label-${gateway.id}`}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={120}
          autoFocus
        />
      </div>
    </FormDialog>
  );
}

/**
 * Name and enabled state. Disabling asks first; re-enabling only resumes acceptance of credentials
 * that are still valid, and a revoked gateway can never be re-enabled, so its switch is not offered.
 */
export function GatewayAvailabilitySection({
  household,
  gateway,
  isAdmin,
}: {
  household: string;
  gateway: NetworkGateway;
  isAdmin: boolean;
}) {
  const update = useUpdateGatewayMutation(household);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoked = Boolean(gateway.revoked_at);

  const setEnabled = (enabled: boolean) => {
    setError(null);
    update.mutate(
      { id: gateway.id, enabled },
      {
        onError: (e) => setError(errorText(e)),
        onSettled: () => setConfirming(false),
      },
    );
  };

  return (
    <SettingsSection title="Availability" icon={<Power />}>
      <SettingsRow label="Label" description={gateway.label} layout="switch">
        {isAdmin ? <RenameGatewayDialog household={household} gateway={gateway} /> : null}
      </SettingsRow>
      <SettingsRow
        label="Enabled"
        layout="switch"
        help="Disabling stops the gateway fetching policy or sending heartbeats right away, even with otherwise valid credentials. It does not erase or revoke credentials, scopes or expiry. Enabling again only resumes accepting credentials that are still valid."
        description={
          revoked
            ? "Revoked gateways stay disabled and can’t be re-enabled. Register a new gateway instead."
            : undefined
        }
        error={error}
      >
        <div className="flex items-center gap-3">
          <EnabledStatus enabled={gateway.enabled} />
          {isAdmin && !revoked ? (
            <SquishSwitch
              {...SWITCH}
              ariaLabel="Gateway enabled"
              checked={gateway.enabled}
              disabled={update.isPending}
              onChange={(next) => (next ? setEnabled(true) : setConfirming(true))}
            />
          ) : null}
        </div>
      </SettingsRow>
      <ConfirmActionDialog
        open={confirming}
        pending={update.isPending}
        title={`Disable ${gateway.label}?`}
        confirmLabel="Disable gateway"
        destructive
        onClose={() => setConfirming(false)}
        onConfirm={() => setEnabled(false)}
      >
        {DISABLE_COPY}
      </ConfirmActionDialog>
    </SettingsSection>
  );
}
