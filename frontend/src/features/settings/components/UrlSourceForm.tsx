import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { InputField } from "@/components/common/form/fields";
import { useServerForm } from "@/hooks/useServerForm";
import { DEFAULT_SOURCE_URL, type UrlCategorizationStatus } from "../hooks/useUrlCategorization";
import { sourceUrlSchema, type SourceUrlValues } from "../lib/urlCategorizationSchemas";

/** Where the UT1 lists come from; edited here and only sent when "Save source URL" is pressed. */
export function UrlSourceForm({ status, version, saving, onSave }: {
  status: UrlCategorizationStatus | null;
  /** Changes whenever a fresh status arrives; re-seeds the field. */
  version: number;
  saving: boolean;
  onSave: (sourceUrl: string) => void;
}) {
  const form = useServerForm<SourceUrlValues, UrlCategorizationStatus>({
    resolver: zodResolver(sourceUrlSchema),
    data: status ?? undefined,
    version,
    toValues: (s) => ({ source_url: s.settings.source_url }),
    initial: { source_url: DEFAULT_SOURCE_URL },
  });

  return (
    <form onSubmit={form.handleSubmit((values) => onSave(values.source_url))} noValidate>
      <InputField
        control={form.control}
        name="source_url"
        id="urlcat-source"
        label="Source URL"
        aria-label="Categorization source URL"
        disabled={saving}
        className="h-9 font-mono text-xs"
        description="Default points to the GitHub mirror tarball over HTTPS. You can switch to a locally hosted or pinned archive URL."
      />
      <div className="mt-4">
        <Button type="submit" variant="outline" size="sm" disabled={saving}>
          {saving && <Spinner />} Save source URL
        </Button>
      </div>
    </form>
  );
}
