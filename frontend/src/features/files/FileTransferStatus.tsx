import { ChevronRight } from "lucide-react";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { cn } from "@/lib/utils";
import type { Breadcrumb } from "./filePaths";
import type { FsMessage } from "./useAgentFs";

/** Clickable path from Root (the drive list) down to the current folder. */
export function FileBreadcrumbs({ crumbs, onNavigate }: { crumbs: Breadcrumb[]; onNavigate: (path: string) => void }) {
  return (
    <nav aria-label="Current folder" className="flex flex-wrap items-center gap-1.5 text-[13px]">
      {crumbs.map((crumb, idx) => {
        const isLast = idx === crumbs.length - 1;
        return (
          <span key={`${crumb.text}-${idx}`} className="flex items-center gap-1.5">
            {idx > 0 && <ChevronRight size={14} className="text-muted-foreground" aria-hidden="true" />}
            {isLast ? (
              <span aria-current="page" className="font-medium text-muted-foreground">{crumb.text}</span>
            ) : (
              <button type="button" onClick={() => onNavigate(crumb.path)} className="text-primary hover:underline">
                {crumb.text}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function Progress({ label, description, value }: { label: string; description: string; value: number }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="flex flex-col gap-1.5" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="text-[13px] font-bold">{label}</div>
      <div className="font-mono text-[11px] text-muted-foreground wrap-break-word">{description}</div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Download/upload progress bars and the latest transfer or file-operation result. */
export function FileTransferStatus({
  downloading,
  downloadProgress,
  uploading,
  uploadProgress,
  uploadMessage,
  fsMessage,
}: {
  downloading: string | null;
  downloadProgress: number;
  uploading: string | null;
  uploadProgress: number;
  uploadMessage: string | null;
  fsMessage: FsMessage | null;
}) {
  return (
    <>
      {downloading && (
        <div className="pt-3">
          <Progress value={downloadProgress} label="Downloading file" description={downloading} />
        </div>
      )}

      {uploading && (
        <div className="pt-3">
          <Progress value={uploadProgress} label="Uploading file" description={uploading} />
        </div>
      )}

      {uploadMessage && (
        <p
          className={cn(
            "pt-2 text-sm",
            /failed|timed out|rejected/i.test(uploadMessage) ? "text-destructive" : "text-success",
          )}
        >
          {uploadMessage}
        </p>
      )}

      {fsMessage ? (
        <div className="pt-3">
          <Alert variant={fsMessage.ok ? "default" : "destructive"}>
            <AlertDescription>{fsMessage.text}</AlertDescription>
          </Alert>
        </div>
      ) : null}
    </>
  );
}
