import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * Editable local copy of server data for staged forms. Re-seeded from `data` whenever a newer
 * server copy arrives (`version` is the query's `dataUpdatedAt`), e.g. after the form saves and
 * the query refetches — the same moment the old "load into state" code overwrote the draft.
 */
export function useServerDraft<T, D>(
  data: T | undefined,
  version: number,
  toDraft: (data: T) => D,
  initial: D,
): [D, Dispatch<SetStateAction<D>>] {
  const [draft, setDraft] = useState<D>(() => (data === undefined ? initial : toDraft(data)));
  const [seededVersion, setSeededVersion] = useState(data === undefined ? 0 : version);
  if (data !== undefined && version !== seededVersion) {
    setSeededVersion(version);
    setDraft(toDraft(data));
  }
  return [draft, setDraft];
}
