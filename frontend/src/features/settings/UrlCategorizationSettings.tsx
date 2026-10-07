import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Search, Trash2, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CategoryManagerModal } from "@/features/settings/CategoryManagerModal";
import { Switch } from "@/components/common/SettingsSwitch";

interface UrlCatSettingsProps {
  isAdmin: boolean;
  urlCatStatus: UrlCategorizationStatus | null;
  urlCatSaving: boolean;
  urlCatLoading: boolean;
  urlCatError: string | null;
  setUrlCatStatus: React.Dispatch<React.SetStateAction<UrlCategorizationStatus | null>>;
  saveUrlCategorization: (patch: Partial<{ enabled: boolean; auto_update: boolean; source_url: string }>) => Promise<void>;
  urlCatUpdateNow: () => Promise<void>;
  refreshUrlCategorization: () => Promise<void>;

  loadOverrides: (q: string) => Promise<{ id: number; kind: "domain" | "url"; value: string; category_key: string; category_label: string; note: string; created_at: string }[]>;
  loadUrlCategories: () => Promise<{ key: string; label?: string; enabled: boolean; description: string }[]>;
  onAddOverride: (body: { kind: "domain" | "url"; value: string; category_key: string; note: string }) => Promise<void>;
  onDeleteOverride: (kind: "domain" | "url", id: number) => Promise<void>;
  onRecalcUrlVisits: () => Promise<void>;
  onRecalcUrlSessions: () => Promise<void>;
}

interface UrlCategorizationStatus {
  settings: {
    enabled: boolean;
    auto_update: boolean;
    source_url: string;
    last_update_at: string | null;
    last_update_error: string | null;
  };
  active_release: { sha256: string | null };
  counts: { categories: number; domains: number; urls: number };
  job?: {
    state: "idle" | "downloading" | "importing" | "ready" | "error";
    started_at: string | null;
    updated_at: string;
    bytes_total: number | null;
    bytes_done: number;
    message: string | null;
  } | null;
}

export function UrlCategorizationSettings({
  isAdmin,
  urlCatStatus,
  urlCatSaving,
  urlCatLoading,
  urlCatError,
  setUrlCatStatus,
  saveUrlCategorization,
  urlCatUpdateNow,
  refreshUrlCategorization,
  loadOverrides,
  loadUrlCategories,
  onAddOverride,
  onDeleteOverride,
  onRecalcUrlVisits,
  onRecalcUrlSessions,
}: UrlCatSettingsProps) {
  const [urlOverridesOpen, setUrlOverridesOpen] = useState(false);
  const [urlOverridesLoading, setUrlOverridesLoading] = useState(false);
  const [urlOverridesError, setUrlOverridesError] = useState<string | null>(null);
  const [urlOverridesQuery, setUrlOverridesQuery] = useState("");
  const [urlOverridesRows, setUrlOverridesRows] = useState<
    { id: number; kind: "domain" | "url"; value: string; category_key: string; category_label: string; note: string; created_at: string }[]
  >([]);
  const [urlOverrideAddKind, setUrlOverrideAddKind] = useState<"domain" | "url">("domain");
  const [urlOverrideAddValue, setUrlOverrideAddValue] = useState("");
  const [urlOverrideAddCategory, setUrlOverrideAddCategory] = useState("");
  const [urlOverrideAddNote, setUrlOverrideAddNote] = useState("");
  const [urlOverrideAddSaving, setUrlOverrideAddSaving] = useState(false);
  const [urlCategories, setUrlCategories] = useState<{ key: string; label?: string; enabled: boolean; description: string }[]>([]);

  const [customCatsOpen, setCustomCatsOpen] = useState(false);

  const fetchOverrides = useCallback(async (q: string) => {
    setUrlOverridesLoading(true);
    setUrlOverridesError(null);
    try {
      const rows = await loadOverrides(q);
      setUrlOverridesRows(rows);
    } catch (e) {
      setUrlOverridesError(String(e));
      setUrlOverridesRows([]);
    } finally {
      setUrlOverridesLoading(false);
    }
  }, [loadOverrides]);

  const fetchCategories = useCallback(async () => {
    try {
      const cats = await loadUrlCategories();
      setUrlCategories(cats);
    } catch {
      setUrlCategories([]);
    }
  }, [loadUrlCategories]);

  useEffect(() => {
    if (!urlOverridesOpen || !isAdmin) return;
    void fetchCategories();
    void fetchOverrides(urlOverridesQuery);
  }, [isAdmin, fetchOverrides, fetchCategories, urlOverridesOpen, urlOverridesQuery]);

  const enabled = urlCatStatus?.settings.enabled ?? false;
  const jobRunning = urlCatStatus?.job?.state === "downloading" || urlCatStatus?.job?.state === "importing";
  const jobProgress =
    urlCatStatus?.job?.bytes_total && urlCatStatus.job.bytes_total > 0
      ? Math.min(100, Math.floor((urlCatStatus.job.bytes_done / urlCatStatus.job.bytes_total) * 100))
      : 0;

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
                      onCheckedChange={(checked) => void saveUrlCategorization({ enabled: checked })}
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
                      onCheckedChange={(checked) => void saveUrlCategorization({ auto_update: checked })}
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
                    setUrlCatStatus((prev) =>
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
                    onClick={() => void saveUrlCategorization({ source_url: urlCatStatus?.settings.source_url ?? "" })}
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
              {jobRunning && (
                <div className="flex flex-col gap-2">
                  <p className="flex items-center gap-2 text-sm text-info">
                    <Spinner />
                    {urlCatStatus.job?.state === "downloading" ? "Downloading list" : "Importing list"}
                  </p>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(jobProgress)}
                    aria-label={urlCatStatus.job?.message ?? "List download progress"}
                    className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${jobProgress}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {urlCatStatus.job?.bytes_total && urlCatStatus.job.bytes_total > 0
                      ? `${Math.floor(urlCatStatus.job.bytes_done / 1024 / 1024)} / ${Math.floor(urlCatStatus.job.bytes_total / 1024 / 1024)} MB`
                      : `${Math.floor((urlCatStatus.job?.bytes_done ?? 0) / 1024 / 1024)} MB`}
                    {urlCatStatus.job?.message ? ` · ${urlCatStatus.job.message}` : ""}
                  </p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={urlCatLoading} onClick={() => void refreshUrlCategorization()}>
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
                  <Button size="sm" disabled={urlCatLoading} onClick={() => void urlCatUpdateNow()}>
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

      <Dialog open={urlOverridesOpen} onOpenChange={(open) => !open && setUrlOverridesOpen(false)}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>URL category overrides</DialogTitle>
            <DialogDescription>
              Overrides apply before UT1 lists and persist across updates. Use domain overrides for hostnames (recommended) and URL overrides for specific prefixes.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-5">
            {urlOverridesError && (
              <Alert variant="destructive">
                <AlertDescription>{urlOverridesError}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="override-kind">Override type</FieldLabel>
                <Select
                  value={urlOverrideAddKind}
                  onValueChange={(value) => value && setUrlOverrideAddKind(value as "domain" | "url")}
                >
                  <SelectTrigger id="override-kind" className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="domain">Domain</SelectItem>
                    <SelectItem value="url">URL prefix</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="override-category">Category</FieldLabel>
                <Select
                  value={urlOverrideAddCategory}
                  onValueChange={(value) => setUrlOverrideAddCategory(value ?? "")}
                >
                  <SelectTrigger id="override-category" className="h-9 w-full">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {urlCategories
                      .filter((c) => c.enabled)
                      .map((c) => {
                        const key = c.key ?? "";
                        const fallback = key
                          .replace(/[_-]+/g, " ")
                          .split(" ")
                          .filter(Boolean)
                          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                          .join(" ");
                        return (
                          <SelectItem key={key} value={key}>
                            {(c.label ?? "").trim() || fallback || key}
                          </SelectItem>
                        );
                      })}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="override-value">{urlOverrideAddKind === "domain" ? "Domain" : "URL prefix"}</FieldLabel>
              <Input
                id="override-value"
                value={urlOverrideAddValue}
                onChange={(event) => setUrlOverrideAddValue(event.target.value)}
                placeholder={urlOverrideAddKind === "domain" ? "example.com" : "https://example.com/path"}
                className="h-9"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="override-note">Note (optional)</FieldLabel>
              <Input
                id="override-note"
                value={urlOverrideAddNote}
                onChange={(event) => setUrlOverrideAddNote(event.target.value)}
                className="h-9"
              />
            </Field>
            <div>
              <Button
                disabled={urlOverrideAddSaving || !urlOverrideAddValue.trim() || !urlOverrideAddCategory.trim()}
                onClick={async () => {
                  setUrlOverrideAddSaving(true);
                  try {
                    await onAddOverride({
                      kind: urlOverrideAddKind,
                      value: urlOverrideAddValue,
                      category_key: urlOverrideAddCategory,
                      note: urlOverrideAddNote,
                    });
                    setUrlOverrideAddValue("");
                    setUrlOverrideAddNote("");
                    await fetchOverrides(urlOverridesQuery);
                  } catch (e) {
                    setUrlOverridesError(String(e));
                  } finally {
                    setUrlOverrideAddSaving(false);
                  }
                }}
              >
                {urlOverrideAddSaving && <Spinner />} Add / update override
              </Button>
            </div>

            <div className="flex flex-col gap-1">
              <InputGroup className="h-9">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label="Search overrides"
                  placeholder="Search overrides (domain/url/category)"
                  value={urlOverridesQuery}
                  onChange={(event) => {
                    setUrlOverridesQuery(event.target.value);
                    void fetchOverrides(event.target.value);
                  }}
                />
                {urlOverridesQuery && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="Clear search"
                      onClick={() => {
                        setUrlOverridesQuery("");
                        void fetchOverrides("");
                      }}
                    >
                      <X />
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await onRecalcUrlVisits();
                  } catch (e) {
                    setUrlOverridesError(String(e));
                  }
                }}
              >
                Re-categorize URL visits
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await onRecalcUrlSessions();
                  } catch (e) {
                    setUrlOverridesError(String(e));
                  }
                }}
              >
                Re-categorize URL sessions
              </Button>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-3">Type</TableHead>
                  <TableHead className="px-3">Value</TableHead>
                  <TableHead className="px-3">Category</TableHead>
                  <TableHead className="px-3">Note</TableHead>
                  <TableHead className="px-3">Created</TableHead>
                  <TableHead className="px-3"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {urlOverridesLoading && urlOverridesRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      <span className="inline-flex items-center gap-2"><Spinner /> Loading…</span>
                    </TableCell>
                  </TableRow>
                ) : urlOverridesRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      No overrides yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  urlOverridesRows.map((r) => (
                    <TableRow key={`${r.kind}-${r.id}`}>
                      <TableCell className="px-3 py-3.5">{r.kind}</TableCell>
                      <TableCell className="px-3 py-3.5 break-all">{r.value}</TableCell>
                      <TableCell className="px-3 py-3.5">{r.category_label || r.category_key}</TableCell>
                      <TableCell className="px-3 py-3.5">{r.note || "—"}</TableCell>
                      <TableCell className="px-3 py-3.5">{new Date(r.created_at).toLocaleString()}</TableCell>
                      <TableCell className="px-3 py-3.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete override for ${r.value}`}
                          onClick={async () => {
                            try {
                              await onDeleteOverride(r.kind, r.id);
                              await fetchOverrides(urlOverridesQuery);
                            } catch (e) {
                              setUrlOverridesError(String(e));
                            }
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUrlOverridesOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
