import { Spinner } from "@vantyr/ui/components/spinner";
import { urlCatJobProgress, type UrlCategorizationStatus } from "../hooks/useUrlCategorization";

const MB = 1024 * 1024;

/** Progress of a running UT1 list download / import (the status is re-read every few seconds meanwhile). */
export function UrlCategorizationJob({ status }: { status: UrlCategorizationStatus }) {
  const job = status.job;
  const progress = urlCatJobProgress(status);
  const known = !!job?.bytes_total && job.bytes_total > 0;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-info/10 px-3.5 py-3">
      <p role="status" className="flex items-center gap-2 text-sm text-info">
        <Spinner />
        {job?.state === "downloading" ? "Downloading the lists…" : "Importing the lists…"}
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(progress) : undefined}
        aria-label="List download progress"
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {known
          ? `${Math.floor(job.bytes_done / MB)} of ${Math.floor((job.bytes_total ?? 0) / MB)} MB`
          : `${Math.floor((job?.bytes_done ?? 0) / MB)} MB so far`}
        {job?.message ? ` · ${job.message}` : ""}
      </p>
    </div>
  );
}
