import { useQuery } from "@tanstack/react-query";
import { LogIn, PowerOff } from "lucide-react";
import { networkQueries } from "@/api/queries/network";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import type { ProxyAccessView } from "@/features/network/runtime/types";
import { useEndProxySessionMutation } from "@/features/network/runtime/useRuntimeQueries";

/**
 * Live proxy sign-ins. "Signed in via the proxy as X" is evidence from one credential, not proof of
 * who is using the device.
 */
export function SessionsCard({
  household,
  access,
  isAdmin,
}: {
  household: string;
  access: ProxyAccessView;
  isAdmin: boolean;
}) {
  const end = useEndProxySessionMutation();
  const devices = useQuery(networkQueries.devices(household));
  const deviceLabel = new Map((devices.data?.devices ?? []).map((d) => [d.id, d.label]));
  const sessions = access.sessions.filter((s) => !s.revoked);

  return (
    <SettingsSection
      title="Sessions"
      icon={<LogIn />}
      description="Proxy sign-in is evidence only. It does not prove who is using the device."
    >
      {sessions.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          No one is signed in via the proxy.
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  Signed in via the proxy as {session.personLabel}
                </div>
                <div className="text-sm text-muted-foreground">
                  {deviceLabel.get(session.deviceId) ?? "Unknown device"}
                </div>
                <div className="text-[0.8125rem] text-muted-foreground">
                  Started <TimeAgo iso={session.startedAt} />
                  {" · "}
                  Last active <TimeAgo iso={session.lastActiveAt} />
                  {" · "}
                  Expires <TimeAgo iso={session.expiresAt} />
                </div>
              </div>
              {isAdmin ? (
                <HoldAction
                  icon={<PowerOff className="size-4" />}
                  ariaLabel={`Hold to end the session for ${session.personLabel}`}
                  doneLabel="Ended"
                  disabled={end.isPending}
                  onHold={() => end.mutate(session.id)}
                >
                  End session
                </HoldAction>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
