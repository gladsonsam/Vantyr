import { useState } from "react";
import { ShieldOff } from "lucide-react";
import { useParams } from "react-router-dom";
import { isApiError } from "@/api";
import { useConsumeSetupGrant, useEnrollmentContexts, useOwnEnrollDevices } from "@/api/queries/network";
import type { NetworkSetupGrantIssued } from "@/api/types";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { PageLoading } from "@/features/network/components/PageLoading";
import { ConsumeSection } from "./ConsumeSection";
import { MyDevicesSection } from "./MyDevicesSection";
import { SecretDialog } from "./SecretDialog";
import { SessionsSection } from "./SessionsSection";
import { SetupSection } from "./SetupSection";

/**
 * Self-service BYOD enrollment for one household, addressed by the id in the URL. It stands
 * outside the administrator-only Network layout: a person with only the enrollment grant cannot
 * list households, so the page asks the enrollment routes directly and treats 403/404 as
 * "no enrollment here".
 */
export function EnrollPage() {
  const { householdId = "" } = useParams();
  const contexts = useEnrollmentContexts();
  const context = contexts.data?.contexts.find((c) => c.household_id === householdId);
  // Labels are display data only; fall back to the id when the context isn't listed.
  const who = context
    ? `${context.household_name || householdId} · ${context.person_display_name || context.person_id}`
    : null;
  usePageHeader({
    title: "Enroll a device",
    description: who
      ? `${who}. Enroll your own devices and verify them with your dashboard sign-in.`
      : "Enroll your own devices and verify them with your dashboard sign-in.",
  });
  const devices = useOwnEnrollDevices(householdId);
  const consume = useConsumeSetupGrant(householdId);
  // The one-time secret lives here only, and is dropped as soon as the dialog closes.
  const [issued, setIssued] = useState<NetworkSetupGrantIssued | null>(null);

  if (devices.isPending) return <PageLoading />;
  if (devices.isError) {
    const status = isApiError(devices.error) ? devices.error.status : 0;
    if (status === 403 || status === 404)
      return (
        <EmptyState
          title="You don’t have BYOD enrollment for this household. Ask an administrator."
          description="Enrolling your own devices needs the enrollment grant and a mapping to a person, both set by a network administrator."
          icon={<ShieldOff className="size-5" />}
          iconVariant="icon"
        />
      );
    return (
      <LoadFailedCard message="Couldn’t load your devices." onRetry={() => void devices.refetch()} />
    );
  }

  const list = devices.data.devices;
  const issuedLabel = list.find((d) => d.id === issued?.device_id)?.label ?? "device";
  const verify = () => {
    if (!issued) return;
    consume.mutate(
      {
        grant_id: issued.grant_id,
        secret: issued.secret,
        purpose: issued.purpose,
        device_id: issued.device_id,
      },
      { onSuccess: () => setIssued(null) },
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <MyDevicesSection household={householdId} devices={list} />
      <SetupSection household={householdId} devices={list} onIssued={setIssued} />
      <ConsumeSection
        devices={list}
        verifying={consume.isPending}
        error={issued ? null : consume.error}
        session={consume.data ?? null}
        onConsume={(body) => consume.mutate(body)}
      />
      <SessionsSection household={householdId} devices={list} />
      <SecretDialog
        issued={issued}
        deviceLabel={issuedLabel}
        verifying={consume.isPending}
        verifyError={consume.error}
        onVerify={verify}
        onClose={() => setIssued(null)}
      />
    </div>
  );
}
