import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { DashboardSessionUser } from "@/api/types";
import { messageOr } from "./messageOr";
import { profileChanges, profileValuesFor, type ProfileValues } from "./userProfile";
import { profileSchema } from "./userSchemas";

/**
 * The signed-in user's profile form. A fresh copy of the account from the server replaces the fields that
 * were not edited and leaves the ones being typed in, so a background refresh never throws away typing.
 * Saving reports its own outcome.
 */
export function useProfileForm(
  me: DashboardSessionUser,
  onSave: (values: ProfileValues) => Promise<void>,
) {
  const seed = profileValuesFor(me);
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    mode: "onChange",
    defaultValues: seed,
  });
  const seedKey = JSON.stringify(seed);
  const seeded = useRef({ key: seedKey, values: seed });
  const latest = useRef({ key: seedKey, values: seed });
  useEffect(() => {
    latest.current = { key: seedKey, values: seed };
  });
  const { reset, getValues } = form;
  // A new copy from the server replaces the fields unless they hold edits that differ from what the server now has.
  const adopt = () => {
    if (latest.current.key === seeded.current.key) return;
    const held = getValues();
    const previous = seeded.current.values;
    const arrived = latest.current.values;
    const merged = { ...arrived };
    for (const key of Object.keys(held) as (keyof ProfileValues)[]) {
      if (held[key] !== previous[key]) merged[key] = held[key];
    }
    seeded.current = latest.current;
    reset(merged);
  };
  const adoptRef = useRef(adopt);
  useEffect(() => {
    adoptRef.current = adopt;
  });
  useEffect(() => {
    adoptRef.current();
  }, [seedKey]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const values = useWatch({ control: form.control });
  const current: ProfileValues = {
    display_name: values.display_name ?? "",
    username: values.username ?? "",
    display_icon: values.display_icon ?? "",
  };

  const submit = form.handleSubmit(async (data) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await onSave(data);
      setSaved(true);
    } catch (e: unknown) {
      setError(messageOr(e, "Failed to save profile"));
    } finally {
      setSaving(false);
    }
  });

  const username = current.username.trim();
  return {
    form,
    current,
    changed: Object.keys(profileChanges(me, current)).length > 0,
    newUsername: username !== "" && username !== me.username ? username : null,
    valid: form.formState.isValid,
    saving,
    error,
    saved,
    submit,
    discard: () => {
      form.reset(seed);
      setError(null);
    },
  };
}
