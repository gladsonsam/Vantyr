import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/api";
import { settingsKeys, settingsQueries } from "@/api/queries/settings";
import type { RetentionPolicy } from "@/api/types";
import {
  parseRetentionFields,
  retentionBody,
  RETENTION_KINDS,
  shortensRetention,
  toRetentionFields,
  type RetentionFields,
  type RetentionKey,
} from "../lib/retention";

/**
 * The server-wide retention limits as a form. Edits live beside the saved copy (`null` = untouched), so a
 * background refresh or a retry never overwrites what is being typed, and an edit that means the same as
 * what is saved (blank vs 0) is not a change.
 */
export function useRetentionSettings(isAdmin: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery(settingsQueries.retention());
  const saved = query.data ?? null;
  const savedFields = saved ? toRetentionFields(saved) : null;
  const [edits, setEdits] = useState<RetentionFields | null>(null);
  const fields = edits ?? savedFields;

  const save = useMutation({
    mutationFn: (body: RetentionPolicy) => api.retentionGlobalPut(body),
    onSuccess: (stored) => {
      queryClient.setQueryData(settingsKeys.retention(), stored);
      setEdits(null);
    },
  });

  const parsed = fields ? parseRetentionFields(fields) : null;
  const savedParsed = savedFields ? parseRetentionFields(savedFields) : null;
  const hasErrors = parsed ? RETENTION_KINDS.some(({ key }) => parsed[key].error) : false;
  const dirty = Boolean(parsed && savedParsed && RETENTION_KINDS.some(({ key }) => parsed[key].days !== savedParsed[key].days));
  const shortened = parsed && saved ? RETENTION_KINDS.filter(({ key }) => shortensRetention(saved[key], parsed[key].days)) : [];

  const settle = () => {
    if (save.isSuccess || save.isError) save.reset();
  };

  return {
    query,
    saved,
    fields,
    parsed,
    dirty,
    hasErrors,
    /** The kinds whose data would now be deleted sooner than before. */
    shortened,
    saving: save.isPending,
    saveError: save.error ? errorText(save.error) : null,
    justSaved: save.isSuccess && !dirty ? save.data : null,
    edit: (key: RetentionKey, value: string) => {
      if (!fields) return;
      settle();
      setEdits({ ...fields, [key]: value });
    },
    discard: () => {
      settle();
      setEdits(null);
    },
    save: () => {
      if (!isAdmin || !parsed || hasErrors || !dirty) return;
      save.mutate(retentionBody(parsed));
    },
  };
}

export type RetentionSettingsForm = ReturnType<typeof useRetentionSettings>;
