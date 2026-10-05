import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "./SettingsSwitch";

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

interface SystemAboutSettingsProps {
  isAdmin: boolean;
  loadingMeta: boolean;
  storage: StorageUsage | null;
  githubRelease: { tag: string | null; releasesUrl: string } | null;
  githubReleaseLoading: boolean;
  githubReleaseError: string | null;
  agentAutoUpdateEnabled: boolean | null;
  agentAutoUpdateLoadErr: string | null;
  onCheckGithubRelease: (nocache: boolean) => Promise<void>;
  onRefreshMeta: () => Promise<void>;
  onSaveAutoUpdate: (enabled: boolean) => Promise<void>;
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

export function SystemAboutSettings({
  isAdmin,
  loadingMeta,
  storage,
  githubRelease,
  githubReleaseLoading,
  githubReleaseError,
  agentAutoUpdateEnabled,
  agentAutoUpdateLoadErr,
  onCheckGithubRelease,
  onRefreshMeta,
  onSaveAutoUpdate,
}: SystemAboutSettingsProps) {
  const [autoUpdateSaving, setAutoUpdateSaving] = useState(false);
  const [autoUpdateSaveErr, setAutoUpdateSaveErr] = useState<string | null>(null);

  const handleAutoUpdateChange = async (checked: boolean) => {
    setAutoUpdateSaving(true);
    setAutoUpdateSaveErr(null);
    try {
      await onSaveAutoUpdate(checked);
    } catch (e) {
      setAutoUpdateSaveErr(String(e));
    } finally {
      setAutoUpdateSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Storage usage */}
      <Card className="gap-0 py-0">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle>Storage usage</CardTitle>
          <CardDescription>
            Total size is PostgreSQL pg_database_size (entire DB on disk). Expand to see per-table breakdown.
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" disabled={loadingMeta} onClick={() => void onRefreshMeta()}>
              {loadingMeta ? <Spinner /> : <RefreshCw />} Refresh usage
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 px-5 pb-5">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              ["Total database size", storage ? formatBytesAdaptive(storage.database_bytes) : "—"],
              ["Public schema", storage ? formatBytesAdaptive(storage.public_tables_bytes) : "—"],
              ["Other", storage ? formatBytesAdaptive(storage.other_bytes) : "—"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-muted/50 px-3.5 py-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 font-mono text-sm">{value}</dd>
              </div>
            ))}
          </dl>

          <details className="group rounded-lg bg-muted/50 px-3.5 py-3">
            <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Details
            </summary>
            <div className="pt-3">
              {storage ? (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    {storage.tables.length} relation{storage.tables.length === 1 ? "" : "s"} in{" "}
                    <code className="font-mono text-xs">public</code> (partition children are rolled into their parent&apos;s size).
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="px-3">Relation</TableHead>
                        <TableHead className="px-3">Size (with indexes)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {storage.tables.map((item) => (
                        <TableRow key={item.name}>
                          <TableCell className="px-3 py-3.5 font-mono text-xs">{item.name}</TableCell>
                          <TableCell className="px-3 py-3.5">{formatBytesAdaptive(item.bytes)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No storage data yet.</p>
              )}
            </div>
          </details>
        </CardContent>
      </Card>

      {/* About */}
      <Card className="gap-0 py-0">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle>About</CardTitle>
          <CardDescription>Tag from the latest GitHub release (same source as server Docker images).</CardDescription>
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              disabled={githubReleaseLoading}
              onClick={() => void onCheckGithubRelease(true)}
            >
              {githubReleaseLoading ? <Spinner /> : <RefreshCw />} Check GitHub now
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 px-5 pb-5">
          {githubReleaseError ? (
            <p className="text-sm text-destructive">{githubReleaseError}</p>
          ) : null}
          {autoUpdateSaveErr ? (
            <Alert variant="destructive">
              <AlertDescription>{autoUpdateSaveErr}</AlertDescription>
            </Alert>
          ) : null}
          {agentAutoUpdateLoadErr ? (
            <Alert variant="destructive">
              <AlertDescription>{agentAutoUpdateLoadErr}</AlertDescription>
            </Alert>
          ) : agentAutoUpdateEnabled === null && loadingMeta ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading agent auto-update policy…
            </div>
          ) : (
            <Field>
              <FieldLabel htmlFor="global-auto-update">Agent auto updates (global default)</FieldLabel>
              <div className="flex flex-wrap items-center gap-3">
                <Switch
                  id="global-auto-update"
                  checked={agentAutoUpdateEnabled ?? false}
                  disabled={
                    agentAutoUpdateEnabled === null || !isAdmin || autoUpdateSaving || loadingMeta
                  }
                  onCheckedChange={(checked) => void handleAutoUpdateChange(checked)}
                />
                <span className="text-sm">Enable agent auto updates by default</span>
                {autoUpdateSaving && <Spinner />}
              </div>
              <FieldDescription>
                {isAdmin
                  ? "When enabled, the server tells connected Windows agents they may check GitHub releases and install updates (policy is pushed over the WebSocket). Operators can still set a per-computer override on each agent's Settings tab."
                  : "Current default policy for Windows agents. Only administrators can change it."}
                {!isAdmin && " Administrator role required to edit."}
              </FieldDescription>
            </Field>
          )}
          <div className="rounded-lg bg-muted/50 px-3.5 py-3">
            <div className="text-xs text-muted-foreground">Latest GitHub release</div>
            <div className="mt-1 font-mono text-sm">
              {githubReleaseLoading && githubRelease == null ? "…" : githubRelease?.tag ?? "—"}
            </div>
            {githubRelease?.releasesUrl ? (
              <p className="mt-1 text-sm text-muted-foreground">
                <a
                  href={githubRelease.releasesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Open releases on GitHub
                </a>
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
