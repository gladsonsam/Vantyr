import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { InputField } from "@/components/common/form/fields";
import { useServerForm } from "@/hooks/useServerForm";
import { DEFAULT_SOURCE_URL, type UrlCategorizationStatus } from "../hooks/useUrlCategorization";
import { sourceUrlSchema, type SourceUrlValues } from "../lib/urlCategorizationSchemas";

/**
 * Where the UT1 lists are downloaded from. Edited here and only sent when "Save source URL" is
 * pressed; the button waits for a change, and the form says when the server took it.
 */
export function UrlSourceForm({
  status,
  version,
  saving,
  onSave,
}: {
  status: UrlCategorizationStatus | null;
  /** Changes whenever a fresh status arrives; re-seeds the field. */
  version: number;
  saving: boolean;
  /** Resolves true once the server accepted the URL (a plain callback just reports nothing). */
  onSave: (sourceUrl: string) => void | Promise<boolean>;
}) {
  const form = useServerForm<SourceUrlValues, UrlCategorizationStatus>({
    resolver: zodResolver(sourceUrlSchema),
    data: status ?? undefined,
    version,
    toValues: (s) => ({ source_url: s.settings.source_url }),
    initial: { source_url: DEFAULT_SOURCE_URL },
  });
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const { isDirty } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    const ok = await onSave(values.source_url);
    setSavedUrl(ok === true ? values.source_url : null);
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <InputField
        control={form.control}
        name="source_url"
        id="urlcat-source"
        label="List source"
        disabled={saving}
        className="h-9 font-mono text-xs"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        description="The archive the lists are downloaded from. The default is the public UT1 mirror on GitHub; use your own mirror or a pinned archive if you prefer."
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" size="sm" disabled={saving || !isDirty}>
          {saving && <Spinner />} Save source URL
        </Button>
        {isDirty ? (
          <span className="text-sm text-muted-foreground">
            Not saved yet. The next download uses the saved address.
          </span>
        ) : savedUrl !== null ? (
          <span role="status" className="text-sm text-success">
            Saved. The next download uses this address.
          </span>
        ) : null}
      </div>
    </form>
  );
}
