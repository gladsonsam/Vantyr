import { LogOut } from "lucide-react";
import { errorText } from "@/api";
import { useEndAllSessions, useEndSession, useOwnSessions } from "@/api/queries/network";
import type { NetworkOwnDevice, NetworkOwnSession } from "@/api/types";
import { Button } from "@vantyr/ui/components/button";
import { HelpTip } from "@/components/common/HelpTip";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { SettingsSection } from "@/features/settings/components/SettingsLayout";
import { purposeLabel } from "./enrollLib";
import { StatusDot } from "./StatusDot";

function isLive(s: NetworkOwnSession): boolean {
  return !s.ended_at && new Date(s.expires_at).getTime() > Date.now();
}

/** Verified network sessions, with end-one and a network-only sign-out. */
export function SessionsSection({
  household,
  devices,
}: {
  household: string;
  devices: NetworkOwnDevice[];
}) {
  const sessions = useOwnSessions(household);
  const endOne = useEndSession(household);
  const endAll = useEndAllSessions(household);
  const rows = sessions.data?.sessions ?? [];
  const live = rows.filter(isLive);
  const result = endOne.data ?? endAll.data;
  const error = endOne.error ?? endAll.error ?? sessions.error;

  return (
    <SettingsSection
      title="My sessions"
      icon={<LogOut />}
      description="Ending network sign-in does not sign you out of the dashboard."
      help="End network sign-in ends your verified sessions and any unused setup grants for this household. Your dashboard session is not affected."
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={live.length === 0 || endAll.isPending}
          onClick={() => endAll.mutate()}
        >
          End network sign-in
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">No verified sessions.</p>
      ) : (
        rows.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {devices.find((d) => d.id === s.device_id)?.label ?? "Device no longer enrolled"}
              </div>
              <div className="text-[0.8125rem] text-muted-foreground">
                {s.person_display_name ? (
                  <span className="inline-flex items-center gap-1.5">
                    Signed in as {s.person_display_name}
                    <HelpTip label="About this label">
                      A label, not proof of who is using the device or of network coverage.
                    </HelpTip>
                  </span>
                ) : null}
                {s.person_display_name ? " · " : ""}
                {purposeLabel(s.purpose)} · verified <TimeAgo iso={s.verified_at} /> · ends{" "}
                <TimeAgo iso={s.expires_at} />
              </div>
            </div>
            <div className="flex items-center gap-4">
              <StatusDot
                tone={isLive(s) ? "success" : "muted"}
                label={isLive(s) ? "Live" : s.ended_at ? "Ended" : "Expired"}
              />
              {isLive(s) ? (
                <HoldAction
                  icon={<LogOut />}
                  ariaLabel="End this session"
                  doneLabel="Ended"
                  disabled={endOne.isPending}
                  onHold={() => endOne.mutate(s.id)}
                >
                  Hold to end
                </HoldAction>
              ) : null}
            </div>
          </div>
        ))
      )}
      {result ? (
        <p className="px-5 py-3 text-[0.8125rem] text-muted-foreground">{result.scope}</p>
      ) : null}
      {error ? (
        <p role="alert" className="px-5 py-3 text-sm text-destructive">
          {errorText(error)}
        </p>
      ) : null}
    </SettingsSection>
  );
}
