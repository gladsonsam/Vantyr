import { Link2 } from "lucide-react";
import { useHref } from "react-router-dom";
import { CopyTextButton } from "@/components/common/CopyTextButton";
import { SettingsRow, SettingsSection } from "@/features/settings/components/SettingsLayout";

/** The household-scoped link people use to enroll their own devices. */
export function EnrollmentLinkSection({ household }: { household: string }) {
  const href = useHref(`/network/enroll/${household}`);
  const url = new URL(href, window.location.origin).href;
  const chooserHref = useHref("/network/enroll");
  const chooserUrl = new URL(chooserHref, window.location.origin).href;
  return (
    <SettingsSection
      title="Enrollment link"
      icon={<Link2 />}
      description="Send this link to people who may enroll their own devices."
      help="The link only opens the enrollment page for this household. It grants nothing by itself: a person needs the network_enroll grant and a mapping to a person before it works."
    >
      <SettingsRow label="Household link" description="Works only for people with the enrollment grant.">
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 truncate rounded-md border border-border/70 px-2 py-1 text-xs">
            {url}
          </code>
          <CopyTextButton text={url} label="Copy link" />
        </div>
      </SettingsRow>
      <SettingsRow
        label="Chooser link"
        description="Lists each household a person is mapped to; opens it directly when there is only one."
      >
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 truncate rounded-md border border-border/70 px-2 py-1 text-xs">
            {chooserUrl}
          </code>
          <CopyTextButton text={chooserUrl} label="Copy chooser link" />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
