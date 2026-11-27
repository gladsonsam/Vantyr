import { useState, type FormEvent } from "react";
import { KeyRound, ShieldOff } from "lucide-react";
import { Navigate, useNavigate } from "react-router-dom";
import { isApiError } from "@/api";
import { useEnrollmentContexts } from "@/api/queries/network";
import { Button } from "@vantyr/ui/components/button";
import { Input } from "@vantyr/ui/components/input";
import { usePageHeader } from "@/app/shell/usePageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { HelpTip } from "@/components/common/HelpTip";
import { PageLoading } from "@/features/network/components/PageLoading";
import { SettingsRow, SettingsSection } from "@/features/settings/components/SettingsLayout";

/** Accepts a pasted enrollment link or a bare household id. */
function householdFromInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const match = /\/network\/enroll\/([^/?#\s]+)/.exec(text);
  const id = match ? match[1] : text;
  return /^[\w-]+$/.test(id) ? id : null;
}

function PasteLinkForm() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const id = householdFromInput(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (id) navigate(`/network/enroll/${encodeURIComponent(id)}`);
  };
  return (
    <form onSubmit={submit} className="flex gap-3">
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Paste an enrollment link or household id"
        aria-label="Enrollment link or household id"
        className="font-mono"
      />
      <Button type="submit" disabled={!id}>
        Open
      </Button>
    </form>
  );
}

/**
 * Entry for people who can only enroll devices: lists the households they are mapped to. It is
 * outside the administrator-gated Network layout and grants nothing by itself.
 */
export function EnrollChooser() {
  usePageHeader({
    title: "Enroll a device",
    description: "Choose the network sign-in you want to enroll a device for.",
  });
  const query = useEnrollmentContexts();
  const navigate = useNavigate();

  if (query.isPending) return <PageLoading />;
  if (query.isError) {
    const status = isApiError(query.error) ? query.error.status : 0;
    if (status === 401)
      return (
        <EmptyState
          title="Sign in to enroll a device"
          description="Enrollment is tied to your dashboard account."
          icon={<ShieldOff className="size-5" />}
          iconVariant="icon"
        />
      );
    return (
      <LoadFailedCard
        message="Couldn’t load your network sign-ins."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const { contexts, has_more, next_offset, pagination_limited } = query.data;
  if (contexts.length === 1 && !has_more) {
    return (
      <Navigate to={`/network/enroll/${encodeURIComponent(contexts[0].household_id)}`} replace />
    );
  }

  if (contexts.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <EmptyState
          title="Nothing to enroll yet"
          description="No enrollment is set up for your account. Ask an administrator to link your account to a person and grant BYOD enrollment."
          icon={<ShieldOff className="size-5" />}
          iconVariant="icon"
        />
        <SettingsSection
          title="Have an enrollment link?"
          icon={<KeyRound />}
          description="Paste a household enrollment link or id to open it directly."
        >
          <div className="px-5 py-4">
            <PasteLinkForm />
          </div>
        </SettingsSection>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <SettingsSection
        title="My network sign-ins"
        icon={<KeyRound />}
        description="The households and people your dashboard account can enroll devices for."
        help="Names are labels from the household, not proof of who is using a device or of network coverage."
      >
        {contexts.map((c) => (
          <SettingsRow
            key={`${c.household_id}:${c.binding_id}`}
            label={c.household_name || c.household_id}
            description={c.person_display_name || c.person_id}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/network/enroll/${encodeURIComponent(c.household_id)}`)}
            >
              Open
            </Button>
          </SettingsRow>
        ))}
        {has_more ? (
          <p className="flex items-center gap-2 px-5 py-3 text-[0.8125rem] text-muted-foreground">
            {next_offset === null || pagination_limited
              ? "More sign-ins exist than this list can show."
              : "More sign-ins exist than are listed."}
            <HelpTip label="About this list">
              The server returned only part of your list and gave no way to fetch the rest. Paste an
              enrollment link below to open a household that is not listed.
            </HelpTip>
          </p>
        ) : null}
      </SettingsSection>
      {has_more ? (
        <SettingsSection title="Open another household" icon={<KeyRound />}>
          <div className="px-5 py-4">
            <PasteLinkForm />
          </div>
        </SettingsSection>
      ) : null}
    </div>
  );
}
