import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorText, isApiError } from "@/api";
import { dnsKeys, usePatchDnsManagement } from "@/api/queries/dnsManagement";
import { validateDnsOperations, type DnsFieldError } from "@/api/dnsManagementValidation";
import type {
  DnsDesiredView,
  DnsManagementConfig,
  DnsManagementPatchResult,
  DnsOperation,
} from "@/api/types";

export const CONFLICT_MESSAGE = "The configuration changed since you loaded it.";
export const STALE_MESSAGE = "This was changed elsewhere. Reload the latest and reopen to edit.";

/** "1 day", "6 hours", "90 minutes", "45 seconds". */
export function formatSecs(secs: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (secs >= 86_400 && secs % 86_400 === 0) return plural(secs / 86_400, "day");
  if (secs >= 3_600 && secs % 3_600 === 0) return plural(secs / 3_600, "hour");
  if (secs >= 60 && secs % 60 === 0) return plural(secs / 60, "minute");
  return plural(secs, "second");
}

/** The first validation message for `path`, or null. */
export function errorAt(errors: DnsFieldError[], path: string): string | null {
  return errors.find((e) => e.path === path)?.message ?? null;
}

/** The version and config snapshot a dialog opened with; its writes are conditional on this. */
export interface DnsBasis {
  basisVersion: number;
  basisConfig: DnsManagementConfig | null;
}

export interface DnsEditor {
  /** Latest version from the query (0 = nothing saved yet). Not a basis for dialog writes. */
  expectedVersion: number;
  busy: boolean;
  /** A write was refused as stale; the user must reload before changing anything. */
  conflict: boolean;
  error: string | null;
  message: string | null;
  /**
   * Validates against the pinned basis, then PATCHes with `expected_config_version = basisVersion`.
   * Refused while `conflict` is set or when the query has moved past the basis. Rejects with a
   * readable message; a 409 raises `conflict` and keeps the server's text.
   */
  submit: (operations: DnsOperation[], basis: DnsBasis) => Promise<DnsManagementPatchResult>;
  /**
   * `submit` for inline controls: errors land in `error`, success in `message`. Uses the current
   * version at click time, but only when it equals the version the control was rendered with.
   */
  run: (operations: DnsOperation[], renderedVersion: number) => Promise<boolean>;
  reload: () => void;
}

/**
 * All writes go through operations against a version the user loaded; a stale version is shown
 * as a conflict with a reload, never retried or overwritten.
 */
export function useDnsEditor(householdId: string, desired: DnsDesiredView | null): DnsEditor {
  const patch = usePatchDnsManagement(householdId);
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const expectedVersion = desired?.config_version ?? 0;
  // Read at click time so a write never uses a version older than the latest render.
  const latest = useRef({ version: expectedVersion, config: desired?.config ?? null });
  const conflictRef = useRef(false);
  useEffect(() => {
    latest.current = { version: expectedVersion, config: desired?.config ?? null };
  }, [expectedVersion, desired]);
  const raiseConflict = useCallback(() => {
    conflictRef.current = true;
    setConflict(true);
  }, []);

  const submit = useCallback(
    async (operations: DnsOperation[], basis: DnsBasis) => {
      if (conflictRef.current)
        throw new Error(`${CONFLICT_MESSAGE} Reload to see the latest before changing anything.`);
      if (basis.basisVersion !== latest.current.version) throw new Error(STALE_MESSAGE);
      const problems = validateDnsOperations(operations, basis.basisConfig, basis.basisVersion);
      if (problems.length > 0) throw new Error(problems[0]!.message);
      try {
        const result = await patch.mutateAsync({
          expected_config_version: basis.basisVersion,
          operations,
        });
        setConflict(false);
        conflictRef.current = false;
        setError(null);
        setMessage(
          result.changed
            ? `Saved as version ${result.desired?.config_version ?? ""}`.trim()
            : "No changes",
        );
        return result;
      } catch (e) {
        if (isApiError(e) && e.status === 409) {
          raiseConflict();
          throw new Error(errorText(e) || CONFLICT_MESSAGE, { cause: e });
        }
        throw e;
      }
    },
    [patch, raiseConflict],
  );

  const run = useCallback(
    async (operations: DnsOperation[], renderedVersion: number) => {
      setError(null);
      setMessage(null);
      try {
        if (renderedVersion !== latest.current.version) throw new Error(STALE_MESSAGE);
        await submit(operations, {
          basisVersion: latest.current.version,
          basisConfig: latest.current.config,
        });
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
        return false;
      }
    },
    [submit],
  );

  const reload = useCallback(() => {
    conflictRef.current = false;
    setConflict(false);
    setError(null);
    setMessage(null);
    void queryClient.invalidateQueries({ queryKey: dnsKeys.root(householdId) });
  }, [queryClient, householdId]);

  return { expectedVersion, busy: patch.isPending, conflict, error, message, submit, run, reload };
}

/** The config a dialog opened with. `pin` re-snapshots the latest when the dialog opens. */
export function usePinnedBasis(desired: DnsDesiredView | null, editor: DnsEditor) {
  const [pinned, setPinned] = useState<DnsDesiredView | null>(desired);
  const latest = useRef(desired);
  useEffect(() => {
    latest.current = desired;
  }, [desired]);
  const pin = useCallback(() => setPinned(latest.current), []);
  const basis: DnsBasis = {
    basisVersion: pinned?.config_version ?? 0,
    basisConfig: pinned?.config ?? null,
  };
  // Changed elsewhere (or a write was refused as stale) while this dialog holds an older snapshot.
  const stale = editor.conflict || (desired?.config_version ?? 0) !== basis.basisVersion;
  return { pinned, basis, stale, pin };
}
