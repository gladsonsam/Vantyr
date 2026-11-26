import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@vantyr/ui/components/card";
import { Spinner } from "@vantyr/ui/components/spinner";
import { Switch } from "@/components/common/SettingsSwitch";
import { LoadFailedCard } from "@/components/common/LoadFailedCard";
import { RefreshButton } from "@/components/common/RefreshButton";
import { CategoryManagerModal } from "./CategoryManagerModal";
import { UrlCategorizationJob } from "./components/UrlCategorizationJob";
import { UrlOverridesDialog } from "./components/UrlOverridesDialog";
import { UrlSourceForm } from "./components/UrlSourceForm";
import {
  urlCatJobRunning,
  type UrlCategorization,
  type UrlCategorizationStatus,
} from "./hooks/useUrlCategorization";

interface UrlCatSettingsProps {
  isAdmin: boolean;
  urlCat: UrlCategorization;
}

const TITLE = "URL categorization";
const WHAT_IT_DOES =
  "Sorts the websites devices visit into categories such as Social or Games, using the UT1 lists, so URL history and analytics can group and filter them.";

export function UrlCategorizationSettings({ isAdmin, urlCat }: UrlCatSettingsProps) {
  const { status, initialLoading, loadError } = urlCat;
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  if (!isAdmin) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle>{TITLE}</CardTitle>
          <CardDescription>{WHAT_IT_DOES}</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5 text-sm text-muted-foreground">
          Only admins can view or change these settings.
        </CardContent>
      </Card>
    );
  }

  // No form until the settings are known: switches that default to "off" would read as the real state,
  // and saving them would overwrite what the server holds.
  if (!status && loadError) {
    return (
      <LoadFailedCard
        message={`Couldn't load URL categorization settings. ${loadError}`}
        onRetry={() => void urlCat.refresh()}
      />
    );
  }

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle>{TITLE}</CardTitle>
          <CardDescription>{WHAT_IT_DOES}</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pt-3 pb-5">
          {!status || initialLoading ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Spinner /> Loading…
            </p>
          ) : (
            <CategorizationBody
              urlCat={urlCat}
              status={status}
              onOpenOverrides={() => setOverridesOpen(true)}
              onOpenCategories={() => setCategoriesOpen(true)}
            />
          )}
        </CardContent>
      </Card>

      <CategoryManagerModal visible={categoriesOpen} onDismiss={() => setCategoriesOpen(false)} />
      <UrlOverridesDialog
        open={overridesOpen}
        isAdmin={isAdmin}
        onClose={() => setOverridesOpen(false)}
      />
    </>
  );
}

function CategorizationBody({
  urlCat,
  status,
  onOpenOverrides,
  onOpenCategories,
}: {
  urlCat: UrlCategorization;
  status: UrlCategorizationStatus;
  onOpenOverrides: () => void;
  onOpenCategories: () => void;
}) {
  const { saving, updatingNow, refreshing, actionError, loadError } = urlCat;
  const [downloadStarted, setDownloadStarted] = useState(false);
  const enabled = status.settings.enabled;
  const jobRunning = urlCatJobRunning(status);

  const startDownload = async () => {
    setDownloadStarted(await urlCat.updateNow());
  };

  return (
    <div className="flex flex-col gap-5">
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>Not changed. {actionError}</AlertDescription>
        </Alert>
      )}
      {loadError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn't refresh the status. What's shown may be out of date. {loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void urlCat.refresh()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-4">
        <SwitchRow
          id="urlcat-enabled"
          label="Categorize website visits"
          hint="Gives each new URL visit a category from the lists."
          checked={enabled}
          disabled={saving}
          onChange={(checked) => void urlCat.save({ enabled: checked })}
        />
        <SwitchRow
          id="urlcat-auto-update"
          label="Keep the lists up to date"
          hint={enabled ? "Downloads fresh lists automatically." : "Turn on categorization first."}
          checked={status.settings.auto_update}
          disabled={saving || !enabled}
          onChange={(checked) => void urlCat.save({ auto_update: checked })}
        />
      </div>

      <UrlSourceForm
        status={status}
        version={urlCat.version}
        saving={saving}
        onSave={(sourceUrl) => urlCat.save({ source_url: sourceUrl })}
      />

      <ListStatus status={status} />
      {jobRunning && <UrlCategorizationJob status={status} />}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!enabled || jobRunning || updatingNow}
            onClick={() => void startDownload()}
          >
            {updatingNow && <Spinner />} Download lists now
          </Button>
          <Button variant="outline" size="sm" disabled={!enabled} onClick={onOpenOverrides}>
            Manage overrides
          </Button>
          <Button variant="outline" size="sm" onClick={onOpenCategories}>
            Manage categories
          </Button>
          <RefreshButton
            label="Refresh status"
            onClick={() => void urlCat.refresh()}
            loading={refreshing}
          />
        </div>
        {downloadStarted && !jobRunning ? (
          <p role="status" className="text-sm text-muted-foreground">
            Download requested. Progress shows here while it runs.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {enabled
            ? "Overrides pin a domain or URL prefix to a category. Categories lets you rename, hide or group the list categories."
            : "Turn on categorization to download lists and manage overrides."}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        Category lists: UT1 (<code className="font-sans">olbat/ut1-blacklists</code>), CC BY-SA 4.0.
      </p>
    </div>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        className="mt-0.5"
      />
      <div className="min-w-0">
        <label id={`${id}-label`} htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

/** What the downloaded lists are right now: failed, missing or ready, with when and how much. */
function ListStatus({ status }: { status: UrlCategorizationStatus }) {
  const { settings, active_release: release, counts, job } = status;
  const failure = settings.last_update_error || (job?.state === "error" ? job.message : null);
  const hasLists = !!release.sha256 || !!settings.last_update_at;
  const updated = settings.last_update_at
    ? new Date(settings.last_update_at).toLocaleString()
    : null;

  let tone = "text-muted-foreground";
  let Icon = CircleDashed;
  let headline = "No lists downloaded yet.";
  if (failure) {
    tone = "text-destructive";
    Icon = AlertTriangle;
    headline = "The last list update failed.";
  } else if (hasLists) {
    tone = "text-success";
    Icon = CheckCircle2;
    headline = updated ? `Lists updated ${updated}.` : "Lists are in place.";
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 px-3.5 py-3">
      <p className={`flex items-start gap-2 text-sm font-medium ${tone}`}>
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{headline}</span>
      </p>
      {failure ? (
        <p className="text-sm text-destructive break-words">
          {failure}
          {updated ? (
            <span className="text-muted-foreground"> Last successful update: {updated}.</span>
          ) : null}
        </p>
      ) : null}
      {hasLists ? (
        <p className="text-sm text-muted-foreground">
          {counts.categories.toLocaleString()} categories · {counts.domains.toLocaleString()}{" "}
          domains · {counts.urls.toLocaleString()} URLs
        </p>
      ) : null}
      {release.sha256 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Release checksum</summary>
          <code className="mt-1 block font-sans break-all">{release.sha256}</code>
        </details>
      ) : null}
    </div>
  );
}
