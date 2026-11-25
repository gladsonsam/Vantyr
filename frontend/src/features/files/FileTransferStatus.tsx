import { ArrowUp, ChevronRight, Copy, X } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { cn } from "@/lib/utils";
import { DRIVES_PATH, baseName, type Breadcrumb } from "./filePaths";
import type { FsMessage } from "./useAgentFs";

/**
 * Where you are: an up button, the clickable path from This PC down to the current folder (one line
 * that scrolls sideways when the path is long, always showing the end), and a copy-path button.
 */
export function FileBreadcrumbs({
  crumbs,
  currentPath,
  onNavigate,
  onCopyPath,
}: {
  crumbs: Breadcrumb[];
  /** Raw path of the current folder; empty or the drive list has nothing to copy. */
  currentPath: string;
  onNavigate: (path: string) => void;
  onCopyPath: () => void;
}) {
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  const canCopy = Boolean(currentPath) && currentPath !== DRIVES_PATH;
  return (
    <div className="flex items-center gap-1 px-3 pt-3 sm:px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        className="max-sm:size-9 pointer-coarse:size-9"
        aria-label={parent ? `Up to ${parent.text}` : "Up one folder"}
        title="Up one folder"
        disabled={!parent}
        onClick={() => parent && onNavigate(parent.path)}
      >
        <ArrowUp />
      </Button>
      <nav
        aria-label="Current folder"
        className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:thin]"
        ref={(element) => {
          // Long paths scroll so the folder you are in stays in view.
          if (element) element.scrollLeft = element.scrollWidth;
        }}
      >
        <ol className="flex w-max min-w-full items-center gap-1 text-[13px]">
          {crumbs.map((crumb, idx) => {
            const isLast = idx === crumbs.length - 1;
            return (
              <li key={crumb.path} className="flex shrink-0 items-center gap-1">
                {idx > 0 && <ChevronRight size={14} className="text-muted-foreground" aria-hidden="true" />}
                {isLast ? (
                  <span aria-current="page" title={crumb.text} className="inline-flex min-h-7 items-center px-1.5 font-medium max-sm:min-h-9 text-foreground">
                    {crumb.text}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onNavigate(crumb.path)}
                    title={crumb.text}
                    className="inline-flex min-h-7 cursor-pointer items-center rounded-md px-1.5 text-muted-foreground max-sm:min-h-9 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:min-h-9"
                  >
                    {crumb.text}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <Button
        variant="ghost"
        size="icon-sm"
        className="max-sm:size-9 pointer-coarse:size-9"
        aria-label="Copy folder path"
        title="Copy folder path"
        disabled={!canCopy}
        onClick={onCopyPath}
      >
        <Copy />
      </Button>
    </div>
  );
}

function Progress({ label, path, value }: { label: string; path: string; value: number }) {
  const pct = Math.min(100, Math.max(0, Math.round(value)));
  const name = baseName(path) || path;
  return (
    <div className="flex flex-col gap-1.5" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} ${name}`}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="min-w-0 wrap-break-word">
          <span className="font-medium">{label}</span> <span title={path}>{name}</span>
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ResultLine({ ok, text, onDismiss }: { ok: boolean; text: string; onDismiss: () => void }) {
  return (
    <div
      role={ok ? "status" : "alert"}
      className={cn("flex items-start justify-between gap-2 rounded-lg px-3 py-1.5 text-[13px]", ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}
    >
      <span className="min-w-0 py-0.5 wrap-break-word">{text}</span>
      <Button variant="ghost" size="icon-xs" className="-mr-1.5 shrink-0 max-sm:size-9 pointer-coarse:size-9" aria-label="Dismiss message" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}

/** Download/upload progress and the latest transfer or file-operation result; empty when nothing is happening. */
export function FileTransferStatus({
  downloading,
  downloadProgress,
  uploading,
  uploadProgress,
  uploadMessage,
  fsMessage,
  onDismissUploadMessage,
  onDismissFsMessage,
}: {
  downloading: string | null;
  downloadProgress: number;
  uploading: string | null;
  uploadProgress: number;
  uploadMessage: string | null;
  fsMessage: FsMessage | null;
  onDismissUploadMessage: () => void;
  onDismissFsMessage: () => void;
}) {
  const uploadFailed = uploadMessage ? /failed|timed out|rejected/i.test(uploadMessage) : false;
  if (!downloading && !uploading && !uploadMessage && !fsMessage) return null;
  return (
    <div className="flex flex-col gap-2 px-3 pt-2 sm:px-4">
      {downloading && <Progress value={downloadProgress} label="Downloading" path={downloading} />}
      {uploading && <Progress value={uploadProgress} label="Uploading" path={uploading} />}
      {uploadMessage && <ResultLine ok={!uploadFailed} text={uploadMessage} onDismiss={onDismissUploadMessage} />}
      {fsMessage && <ResultLine ok={fsMessage.ok} text={fsMessage.text} onDismiss={onDismissFsMessage} />}
    </div>
  );
}
