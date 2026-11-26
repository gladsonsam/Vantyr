import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@/api";
import { dnsKeys, usePatchDnsManagement } from "@/api/queries/dnsManagement";
import { validateDnsOperations, type DnsFieldError } from "@/api/dnsManagementValidation";
import type { DnsDesiredView, DnsManagementPatchResult, DnsOperation } from "@/api/types";

export const CONFLICT_MESSAGE = "The configuration changed since you loaded it.";

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

export interface DnsEditor {
  /** Version the next write is conditional on (0 = nothing saved yet). */
  expectedVersion: number;
  busy: boolean;
  /** A write was refused as stale; the user must reload before changing anything. */
  conflict: boolean;
  error: string | null;
  message: string | null;
  /** Validates, then PATCHes. Rejects with a readable message (409 also raises `conflict`). */
  submit: (operations: DnsOperation[]) => Promise<DnsManagementPatchResult>;
  /** `submit` for inline controls: errors land in `error`, success in `message`. */
  run: (operations: DnsOperation[]) => Promise<boolean>;
  reload: () => void;
}

/**
 * All writes go through operations against the version the user loaded; a stale version is shown
 * as a conflict with a reload, never retried or overwritten.
 */
export function useDnsEditor(householdId: string, desired: DnsDesiredView | null): DnsEditor {
  const patch = usePatchDnsManagement(householdId);
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const expectedVersion = desired?.config_version ?? 0;

  const submit = useCallback(
    async (operations: DnsOperation[]) => {
      const problems = validateDnsOperations(operations, desired?.config ?? null, expectedVersion);
      if (problems.length > 0) throw new Error(problems[0]!.message);
      try {
        const result = await patch.mutateAsync({ expected_config_version: expectedVersion, operations });
        setConflict(false);
        setError(null);
        setMessage(
          result.changed
            ? `Saved as version ${result.desired?.config_version ?? ""}`.trim()
            : "No changes",
        );
        return result;
      } catch (e) {
        if (isApiError(e) && e.status === 409) {
          setConflict(true);
          throw new Error(CONFLICT_MESSAGE, { cause: e });
        }
        throw e;
      }
    },
    [desired, expectedVersion, patch],
  );

  const run = useCallback(
    async (operations: DnsOperation[]) => {
      setError(null);
      setMessage(null);
      try {
        await submit(operations);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
        return false;
      }
    },
    [submit],
  );

  const reload = useCallback(() => {
    setConflict(false);
    setError(null);
    setMessage(null);
    void queryClient.invalidateQueries({ queryKey: dnsKeys.root(householdId) });
  }, [queryClient, householdId]);

  return { expectedVersion, busy: patch.isPending, conflict, error, message, submit, run, reload };
}
