import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/common/SettingsSwitch";
import { CategoryManagerModal } from "./CategoryManagerModal";
import { UrlCategorizationJob } from "./components/UrlCategorizationJob";
import { UrlOverridesDialog } from "./components/UrlOverridesDialog";
import { urlCatJobRunning, type UrlCategorization } from "./hooks/useUrlCategorization";

interface UrlCatSettingsProps {
  isAdmin: boolean;
  urlCat: UrlCategorization;
}

export function UrlCategorizationSettings({ isAdmin, urlCat }: UrlCatSettingsProps) {
  const { status: urlCatStatus, saving: urlCatSaving, loading: urlCatLoading, error: urlCatError } = urlCat;
  const [urlOverridesOpen, setUrlOverridesOpen] = useState(false);
  const [customCatsOpen, setCustomCatsOpen] = useState(false);

  const enabled = urlCatStatus?.settings.enabled ?? false;
  const jobRunning = urlCatJobRunning(urlCatStatus);

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle>URL categorization (UT1 Blacklists)</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          {!isAdmin ? (
            <Alert>
              <AlertDescription>Admin only.</AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-5">
              {urlCatError && (
                <Alert variant="destructive">
                  <AlertDescription>{urlCatError}</AlertDescription>
                </Alert>
              )}
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="urlcat-enabled">Enabled</FieldLabel>
                  <div className="flex items-center gap-3">
                    <Switch
                      id="urlcat-enabled"
                      checked={enabled}
                      onCheckedChange={(checked) => void urlCat.save({ enabled: checked })}
                      disabled={urlCatSaving}
                    />
                    <span className="text-sm">Categorize new URL visits</span>
                  </div>
                  <FieldDescription>
                    Disabled by default. When enabled, new URL visits are categorized in the background.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="urlcat-auto-update">Auto update</FieldLabel>
                  <div className="flex items-center gap-3">
                    <Switch
                      id="urlcat-auto-update"
                      checked={urlCatStatus?.settings.auto_update ?? true}
                      onCheckedChange={(checked) => void urlCat.save({ auto_update: checked })}
                      disabled={urlCatSaving || !enabled}
                    />
                    <span className="text-sm">Automatically refresh categorization lists</span>
                  </div>
                  <FieldDescription>
                    When enabled, the server periodically refreshes the list while categorization is enabled.
                  </FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="urlcat-source">Source URL</FieldLabel>
                <Input
                  id="urlcat-source"
                  aria-label="Categorization source URL"
                  value={
                    urlCatStatus?.settings.source_url ??
                    "https://github.com/olbat/ut1-blacklists/archive/refs/heads/master.tar.gz"
                  }
                  onChange={(event) =>
                    urlCat.setStatus((prev) =>
                      prev ? { ...prev, settings: { ...prev.settings, source_url: event.target.value } } : prev
                    )
                  }
                  disabled={urlCatSaving}
                  className="h-9 font-mono text-xs"
                />
                <FieldDescription>
                  Default points to the GitHub mirror tarball over HTTPS. You can switch to a locally hosted or pinned archive URL.
                </FieldDescription>
                <div className="mt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void urlCat.save({ source_url: urlCatStatus?.settings.source_url ?? "" })}
                    disabled={urlCatSaving}
                  >
                    {urlCatSaving && <Spinner />} Save source URL
                  </Button>
                </div>
              </Field>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-lg bg-muted/50 px-3.5 py-3">
                  <dt className="text-xs text-muted-foreground">Last update</dt>
                  <dd className="mt-1 text-sm">
                    {urlCatStatus?.settings.last_update_at
                      ? new Date(urlCatStatus.settings.last_update_at).toLocaleString()
                      : "—"}
                  </dd>
                </div>
                <div className="rounded-lg bg-muted/50 px-3.5 py-3">
                  <dt className="text-xs text-muted-foreground">Active sha256</dt>
                  <dd className="mt-1 font-mono text-xs break-all">{urlCatStatus?.active_release.sha256 ?? "—"}</dd>
                </div>
                <div className="rounded-lg bg-muted/50 px-3.5 py-3">
                  <dt className="text-xs text-muted-foreground">Counts</dt>
                  <dd className="mt-1 text-sm">{`${urlCatStatus?.counts.categories ?? 0} categories / ${urlCatStatus?.counts.domains.toLocaleString() ?? 0} domains / ${urlCatStatus?.counts.urls.toLocaleString() ?? 0} URLs`}</dd>
                </div>
              </dl>
              {urlCatStatus?.settings.last_update_error && (
                <p className="text-sm text-destructive">{urlCatStatus.settings.last_update_error}</p>
              )}
              {jobRunning && urlCatStatus && <UrlCategorizationJob status={urlCatStatus} />}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={urlCatLoading} onClick={() => void urlCat.refresh()}>
                  {urlCatLoading ? <Spinner /> : <RefreshCw />} Refresh
                </Button>
                {enabled ? (
                  <Button variant="outline" size="sm" onClick={() => setUrlOverridesOpen(true)}>
                    Manage overrides
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => setCustomCatsOpen(true)}>
                  Custom categories
                </Button>
                {enabled ? (
                  <Button size="sm" disabled={urlCatLoading} onClick={() => void urlCat.updateNow()}>
                    {urlCatLoading && <Spinner />} Download/update now
                  </Button>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Enable URL categorization to download lists and manage overrides.
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Data source: UT1 Blacklists (<code className="font-mono">olbat/ut1-blacklists</code>) licensed under Creative Commons
                BY-SA 4.0.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <CategoryManagerModal visible={customCatsOpen} onDismiss={() => setCustomCatsOpen(false)} />

      <UrlOverridesDialog open={urlOverridesOpen} isAdmin={isAdmin} onClose={() => setUrlOverridesOpen(false)} />
    </>
  );
}
