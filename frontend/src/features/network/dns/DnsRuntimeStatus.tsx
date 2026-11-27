import { AlertTriangle } from "lucide-react";
import { HelpTip } from "@/components/common/HelpTip";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import type { DnsView } from "@/features/network/runtime/types";
import { Button } from "@vantyr/ui/components/button";
import { DNS_SETTINGS_CONFLICT, useDnsSettingsEdit } from "./dnsSettingsEdit";

/** Saved is stored; applied is only what a gateway reports. Never "verified", "enforced" or "protected". */
export function DnsSettingsStatusLine({ dns }: { dns: DnsView }) {
  const { settingsVersion: version, settingsStatus: status } = dns;
  let applied;
  if (status.appliedVersion === null) {
    applied = "No gateway report yet";
  } else if (status.appliedVersion === version) {
    applied = (
      <>
        Gateway reports applied version {status.appliedVersion} <TimeAgo iso={status.reportedAt} />
      </>
    );
  } else {
    applied = `Waiting for the gateway to report version ${version} (it reports ${status.appliedVersion})`;
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <span className="text-foreground">
        Settings version {version} · {status.saved ? "Saved" : "Not saved"}
      </span>
      <span aria-hidden="true">·</span>
      <span>{applied}</span>
      <HelpTip label="About saved and applied">
        Saved means stored; applied is what a gateway reports; neither is verification.
      </HelpTip>
    </p>
  );
}

export function DnsSettingsNotices() {
  const edit = useDnsSettingsEdit();
  return (
    <>
      {edit.conflict ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/50 bg-card/10 px-5 py-4 text-sm"
        >
          <span className="flex items-center gap-2 text-warning">
            <AlertTriangle className="size-4" aria-hidden="true" />
            {DNS_SETTINGS_CONFLICT}. Nothing was overwritten. Reload to see the latest before
            changing anything.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={edit.reload}
            disabled={edit.reloading}
          >
            Reload
          </Button>
        </div>
      ) : null}
      {edit.error ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive/50 bg-card/10 px-5 py-3 text-sm text-destructive"
        >
          {edit.error}
        </p>
      ) : null}
    </>
  );
}
