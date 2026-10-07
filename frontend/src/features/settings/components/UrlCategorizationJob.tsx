import { Spinner } from "@/components/ui/spinner";
import { urlCatJobProgress, type UrlCategorizationStatus } from "../hooks/useUrlCategorization";

/** Progress of a running UT1 list download / import. */
export function UrlCategorizationJob({ status }: { status: UrlCategorizationStatus }) {
  const job = status.job;
  const progress = urlCatJobProgress(status);
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-sm text-info">
        <Spinner />
        {job?.state === "downloading" ? "Downloading list" : "Importing list"}
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        aria-label={job?.message ?? "List download progress"}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {job?.bytes_total && job.bytes_total > 0
          ? `${Math.floor(job.bytes_done / 1024 / 1024)} / ${Math.floor(job.bytes_total / 1024 / 1024)} MB`
          : `${Math.floor((job?.bytes_done ?? 0) / 1024 / 1024)} MB`}
        {job?.message ? ` · ${job.message}` : ""}
      </p>
    </div>
  );
}
