import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn, copyToClipboard } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

/**
 * A value you can copy with one press: the text itself is the button, a copy icon says so, and the
 * result (copied / couldn't copy) is announced and shown next to it.
 */
export function CopyValue({ text, label, mono = false, className }: {
  text: string;
  /** What is being copied, for the accessible name ("MAC address"). */
  label?: string;
  mono?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    const ok = await copyToClipboard(text);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };

  return (
    <span className={cn("-mx-1 inline-flex max-w-full items-start gap-1.5", className)}>
      <button
        type="button"
        onClick={() => void copy()}
        title={`Copy ${label ?? "value"}`}
        aria-label={`Copy ${label ? `${label} ` : ""}${text}`}
        className={cn(
          "group/copy inline-flex min-h-6 max-w-full cursor-pointer items-start gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none max-sm:min-h-9 pointer-coarse:min-h-9",
          mono && "font-mono text-[13px]",
        )}
      >
        <span className="min-w-0 wrap-break-word">{text}</span>
        {state === "copied" ? (
          <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <Copy className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100 pointer-coarse:opacity-100" aria-hidden="true" />
        )}
      </button>
      <span role="status" className={cn("mt-1 text-xs", state === "failed" ? "text-destructive" : "sr-only")}>
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn’t copy" : ""}
      </span>
    </span>
  );
}
