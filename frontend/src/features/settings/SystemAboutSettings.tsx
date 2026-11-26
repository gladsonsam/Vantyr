import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vantyr/ui/components/table";
import { Spinner } from "@vantyr/ui/components/spinner";
import { errorText } from "@/api";
import type { SettingsVersionPayload } from "@/api/serverVersionStore";
import { Switch } from "@/components/common/SettingsSwitch";
import { KeyValueCard, KeyValueGrid } from "@/components/common/resource-detail/KeyValueCard";
import { SettingsCardBody, SettingsRow, SettingsSection } from "./components/SettingsLayout";

interface StorageTableItem {
  name: string;
  bytes: number;
}

interface StorageUsage {
  database_bytes: number;
  public_tables_bytes: number;
  other_bytes: number;
  tables: StorageTableItem[];
}

/** One thing the page loads: what it has, what went wrong, and how to ask again. */
interface Loaded<T> {
  data: T | null;
  /** The last failure, kept beside `data` so an old result is never shown as if it were current. */
  error: string | null;
  loading: boolean;
  /** When `data` was last fetched successfully (ms), or 0. */
  updatedAt: number;
  onReload: () => void;
}

interface SystemAboutSettingsProps {
  isAdmin: boolean;
  storage: Loaded<StorageUsage>;
  version: Loaded<SettingsVersionPayload>;
  autoUpdate: Omit<Loaded<{ enabled: boolean }>, "updatedAt"> & {
    onSave: (enabled: boolean) => Promise<void>;
  };
}

function formatBytesAdaptive(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(2)} ${units[idx]}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The one button that asks the server again. */
function RefreshAction({
  action,
  loading,
  onClick,
}: {
  action: string;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" size="sm" disabled={loading} onClick={onClick}>
      {loading ? <Spinner /> : <RefreshCw />} {action}
    </Button>
  );
}

function StaleNotice({
  children,
  loading,
  onRetry,
}: {
  children: string;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{children}</span>
        <Button variant="outline" size="sm" disabled={loading} onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function SystemAboutSettings({
  isAdmin,
  storage,
  version,
  autoUpdate,
}: SystemAboutSettingsProps) {
  return (
    <div className="flex flex-col gap-8">
      <UpdatesCard isAdmin={isAdmin} version={version} autoUpdate={autoUpdate} />
      <StorageUsageCard storage={storage} />
    </div>
  );
}

/** What the version check proves: "Up to date" only from a fresh, successful answer that names a latest release. */
function versionStatus(payload: SettingsVersionPayload): {
  text: string;
  tone: "ok" | "update" | "unknown";
} {
  if (payload.server_update_available && payload.latest_server_release) {
    return { text: `Update available: ${payload.latest_server_release}`, tone: "update" };
  }
  if (!payload.latest_server_release) return { text: "Latest release unknown", tone: "unknown" };
  return { text: "Up to date", tone: "ok" };
}

function UpdatesCard({
  isAdmin,
  version,
  autoUpdate,
}: Pick<SystemAboutSettingsProps, "isAdmin" | "version" | "autoUpdate">) {
  const payload = version.data;
  return (
    <SettingsSection
      title="Server version"
      help="The latest tag comes from the newest GitHub release, the same source as the server Docker images."
      action={
        <RefreshAction
          action="Check for updates"
          loading={version.loading}
          onClick={version.onReload}
        />
      }
    >
      <SettingsCardBody className="space-y-5">
        {version.error && (
          <StaleNotice loading={version.loading} onRetry={version.onReload}>
            {payload
              ? `Couldn't check GitHub just now. Showing the result from ${clock(version.updatedAt)}.`
              : `Couldn't check for updates. ${version.error}`}
          </StaleNotice>
        )}
        {payload ? (
          <VersionDetails payload={payload} checkedAt={version.updatedAt} />
        ) : !version.error ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Checking for updates…
          </div>
        ) : null}
      </SettingsCardBody>
      <AutoUpdatePolicy isAdmin={isAdmin} autoUpdate={autoUpdate} />
    </SettingsSection>
  );
}

const STATUS_TONE = {
  ok: "text-success",
  update: "text-foreground",
  unknown: "text-muted-foreground",
} as const;

function VersionDetails({
  payload,
  checkedAt,
}: {
  payload: SettingsVersionPayload;
  checkedAt: number;
}) {
  const status = versionStatus(payload);
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className={`text-sm font-medium ${STATUS_TONE[status.tone]}`}>
        {status.text}
        {checkedAt > 0 && (
          <span className="font-normal text-muted-foreground"> · checked {clock(checkedAt)}</span>
        )}
      </p>
      <KeyValueGrid className="lg:grid-cols-3 xl:grid-cols-3">
        <Fact label="Running" value={payload.server_version} />
        <Fact label="Latest release" value={payload.latest_server_release ?? "—"} />
        <Fact label="Latest agent" value={payload.latest_agent_version ?? "—"} />
      </KeyValueGrid>
      {payload.releases_url ? (
        <p className="text-sm">
          <a
            href={payload.releases_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            Open releases on GitHub
          </a>
        </p>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <KeyValueCard label={label} format="text">
      {value}
    </KeyValueCard>
  );
}

function StorageUsageCard({ storage }: { storage: Loaded<StorageUsage> }) {
  const usage = storage.data;
  return (
    <SettingsSection
      title="Storage usage"
      help="Total size is PostgreSQL pg_database_size (the entire database on disk). Details lists each table."
      action={
        <RefreshAction action="Refresh usage" loading={storage.loading} onClick={storage.onReload} />
      }
    >
      <SettingsCardBody className="space-y-5">
        {storage.error && (
          <StaleNotice loading={storage.loading} onRetry={storage.onReload}>
            {usage
              ? `Couldn't refresh usage. Showing the sizes from ${clock(storage.updatedAt)}.`
              : `Couldn't load storage usage. ${storage.error}`}
          </StaleNotice>
        )}

        {usage ? (
          <>
            <KeyValueGrid className="lg:grid-cols-3 xl:grid-cols-3">
              <Fact label="Total database size" value={formatBytesAdaptive(usage.database_bytes)} />
              <Fact label="Public schema" value={formatBytesAdaptive(usage.public_tables_bytes)} />
              <Fact label="Other" value={formatBytesAdaptive(usage.other_bytes)} />
            </KeyValueGrid>
            {storage.updatedAt > 0 && (
              <p className="-mt-3 text-xs text-muted-foreground">
                As of {clock(storage.updatedAt)}
              </p>
            )}

            <details className="group rounded-xl border border-border/70 px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Details by table ({usage.tables.length})
              </summary>
              <div className="flex flex-col gap-3 pt-3">
                <p className="text-sm text-muted-foreground">
                  Tables in <code className="font-sans text-xs">public</code>; partition children
                  are rolled into their parent&apos;s size.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-3">Table</TableHead>
                      <TableHead className="px-3">Size (with indexes)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usage.tables.map((item) => (
                      <TableRow key={item.name}>
                        <TableCell className="px-3 py-3.5 font-sans text-xs break-all">
                          {item.name}
                        </TableCell>
                        <TableCell className="px-3 py-3.5">
                          {formatBytesAdaptive(item.bytes)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          </>
        ) : !storage.error ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading storage usage…
          </div>
        ) : null}
      </SettingsCardBody>
    </SettingsSection>
  );
}

/** The global default for Windows agent auto-updates; the switch shows only what the server confirmed. */
function AutoUpdatePolicy({
  isAdmin,
  autoUpdate,
}: Pick<SystemAboutSettingsProps, "isAdmin" | "autoUpdate">) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const enabled = autoUpdate.data?.enabled ?? null;

  const change = async (next: boolean) => {
    setSaving(true);
    setSaveError(null);
    try {
      await autoUpdate.onSave(next);
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="global-auto-update-label" className="flex flex-col">
      {autoUpdate.error && !autoUpdate.data ? (
        <div className="px-5 py-4">
          <StaleNotice loading={autoUpdate.loading} onRetry={autoUpdate.onReload}>
            {`Couldn't load the agent auto-update default. ${autoUpdate.error}`}
          </StaleNotice>
        </div>
      ) : enabled === null ? (
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground">
          <Spinner /> Loading agent auto-update default…
        </div>
      ) : (
        <>
          {autoUpdate.error && (
            <div className="px-5 pt-4">
              <StaleNotice loading={autoUpdate.loading} onRetry={autoUpdate.onReload}>
                Couldn&apos;t re-check the agent auto-update default, so it may be out of date.
              </StaleNotice>
            </div>
          )}
          <SettingsRow
            layout="switch"
            htmlFor="global-auto-update"
            label={<span id="global-auto-update-label">Agent auto-updates by default</span>}
            help="When on, the server tells connected Windows agents they may check GitHub releases and install updates (the policy is pushed over the WebSocket). A device can override this on its own Settings tab."
            description={enabled ? "On" : "Off"}
          >
            <div className="flex items-center gap-3">
              {saving && <Spinner />}
              <Switch
                id="global-auto-update"
                checked={enabled}
                disabled={!isAdmin || saving}
                onCheckedChange={(checked) => void change(checked)}
                aria-labelledby="global-auto-update-label"
              />
            </div>
          </SettingsRow>
          {saveError && (
            <div className="px-5 pb-4">
              <Alert variant="destructive">
                <AlertDescription>Not saved. {saveError}</AlertDescription>
              </Alert>
            </div>
          )}
          {!isAdmin && (
            <p className="px-5 pb-4 text-sm text-muted-foreground">
              Only admins can change this default.
            </p>
          )}
        </>
      )}
    </section>
  );
}
