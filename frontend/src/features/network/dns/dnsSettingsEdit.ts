import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useDnsQuery, useUpdateDnsMutation } from "@/features/network/runtime/useRuntimeQueries";
import { RuntimeConflictError, type DnsSettingsPatch } from "@/features/network/runtime/types";

export const DNS_SETTINGS_CONFLICT = "The DNS settings changed since you loaded them";

export interface DnsSettingsEdit {
  /** The version the latest render shows. A control must capture it while rendering and pass it to `commit`. */
  version: number;
  conflict: boolean;
  error: string | null;
  /** Every control is disabled while a conflict is unresolved. */
  disabled: boolean;
  /** Sends the patch against `renderedVersion`. Dropped while a conflict is set. Never overwrites silently. */
  commit: (patch: DnsSettingsPatch, renderedVersion: number) => void;
  reload: () => void;
  reloading: boolean;
}

export const DnsSettingsEditContext = createContext<DnsSettingsEdit | null>(null);

export function useDnsSettingsEdit(): DnsSettingsEdit {
  const value = useContext(DnsSettingsEditContext);
  if (!value) throw new Error("DNS settings controls must render inside the DNS settings editor");
  return value;
}

function isConflict(error: unknown) {
  return (
    error instanceof RuntimeConflictError ||
    (error as { kind?: string } | null)?.kind === "conflict"
  );
}

/** Page-level conflict and error state for compare-and-set edits of the DNS runtime settings. */
export function useDnsSettingsEditState(version: number): DnsSettingsEdit {
  const query = useDnsQuery();
  const update = useUpdateDnsMutation();
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const conflictRef = useRef(false);
  const mutate = update.mutate;

  const commit = useCallback(
    (patch: DnsSettingsPatch, renderedVersion: number) => {
      if (conflictRef.current) return;
      mutate(
        { ...patch, expectedSettingsVersion: renderedVersion },
        {
          onSuccess: (result) => {
            if (result.state === "unavailable") setError(result.reason);
            else setError(null);
          },
          onError: (failure) => {
            if (isConflict(failure)) {
              conflictRef.current = true;
              setConflict(true);
              setError(null);
            } else {
              setError(failure instanceof Error ? failure.message : String(failure));
            }
          },
        },
      );
    },
    [mutate],
  );

  const refetch = query.refetch;
  const reload = useCallback(() => {
    setReloading(true);
    void refetch().finally(() => {
      conflictRef.current = false;
      setConflict(false);
      setError(null);
      setReloading(false);
    });
  }, [refetch]);

  return useMemo(
    () => ({ version, conflict, error, disabled: conflict, commit, reload, reloading }),
    [version, conflict, error, commit, reload, reloading],
  );
}
