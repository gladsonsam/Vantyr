import { useEffect, useRef } from "react";
import { useForm, type DefaultValues, type FieldValues, type Resolver, type UseFormProps, type UseFormReturn } from "react-hook-form";

/**
 * A react-hook-form form seeded from server data. Like `useServerDraft`, it is re-seeded whenever a
 * newer server copy arrives (`version` is the query's `dataUpdatedAt`), e.g. after the form saves
 * and the query refetches, overwriting unsaved edits.
 */
export function useServerForm<V extends FieldValues, D>({
  resolver,
  data,
  version,
  toValues,
  initial,
  mode,
}: {
  resolver: Resolver<V>;
  data: D | undefined;
  version: number;
  toValues: (data: D) => V;
  /** Values shown until `data` exists. */
  initial: V;
  mode?: UseFormProps<V>["mode"];
}): UseFormReturn<V, unknown, V> {
  const form = useForm<V, unknown, V>({ resolver, mode, defaultValues: (data === undefined ? initial : toValues(data)) as DefaultValues<V> });
  const seeded = useRef(data === undefined ? 0 : version);
  const toValuesRef = useRef(toValues);
  useEffect(() => {
    toValuesRef.current = toValues;
  });
  const { reset } = form;
  useEffect(() => {
    if (data !== undefined && version !== seeded.current) {
      seeded.current = version;
      reset(toValuesRef.current(data));
    }
  }, [data, version, reset]);
  return form;
}
